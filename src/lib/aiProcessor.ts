import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
if (!apiKey) {
  console.warn('[AI] GEMINI_API_KEY não definida no ambiente.');
}

const genAI = new GoogleGenerativeAI(apiKey);

/**
 * Interface rigorosa de retorno para agendamentos extraídos pela IA.
 */
export interface ResultadoAgendamento {
  is_agendamento: boolean;
  data_iso: string | null;
  horario: string | null;
  descricao: string | null;
  categoria?: string | null; // 'entrega', 'servico', 'vistoria', 'outro'
}

export interface AnaliseConflito {
  tem_conflito: boolean;
  motivo_conflito: string | null;
  sugestao: string | null;
}

/**
 * Interface para extração flexível em lote (SMS, e-mails, atas, notas).
 */
export interface EventoExtraidoLote {
  data_iso: string;
  horario: string | null;
  descricao: string;
  categoria: string;
  confianca: number; // 0 a 100
  obra_sugerida?: string | null;
}

export interface ResultadoExtracaoLote {
  sucesso: boolean;
  resumo_contexto: string;
  obra_detectada: string | null;
  eventos: EventoExtraidoLote[];
}

/**
 * Interface do Gerador de Especificações / Prompts para Engenharia de Software.
 */
export interface SolucaoEngenharia {
  ticket_id: string;
  titulo_demanda: string;
  categoria: 'relatorio' | 'integracao' | 'automacao' | 'interface' | 'banco_dados';
  resumo_executivo: string;
  especificacao_tecnica: {
    arquivos_afetados: string[];
    mudancas_backend: string;
    mudancas_frontend: string;
    queries_supabase_ddl?: string;
  };
  prompt_ide: string;
  criterios_aceite: string[];
}

/**
 * Extrai agendamentos de mensagens em linguagem natural com Gemini.
 */
export async function extrairAgendamento(
  textoMensagem: string,
  dataAtualBase: string
): Promise<ResultadoAgendamento> {
  const fallbackSeguro: ResultadoAgendamento = {
    is_agendamento: false,
    data_iso: null,
    horario: null,
    descricao: null,
    categoria: null,
  };

  if (!textoMensagem || textoMensagem.trim().length === 0) {
    return fallbackSeguro;
  }

  try {
    const dataRefObj = new Date(`${dataAtualBase}T12:00:00Z`);
    const diaSemanaTexto = dataRefObj.toLocaleDateString('pt-BR', { weekday: 'long' });

    const systemInstruction = `
Você é uma IA de ponta especializada em logística e gestão de obras da construção civil brasileira.
Sua missão é ler mensagens operacionais de canteiro de obras e extrair com precisão cirúrgica qualquer evento futuro de agendamento (entregas de materiais, concretagens, instalações, vistorias técnicas, manutenções ou montagens).

REGRAS DE CONVERSÃO DE TEMPO:
1. Hoje é: ${dataAtualBase} (${diaSemanaTexto}).
2. "Amanhã" = ${dataAtualBase} + 1 dia.
3. "Depois de amanhã" = ${dataAtualBase} + 2 dias.
4. "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo": Calcule o próximo dia correspondente mais próximo no futuro (se hoje for terça e o usuário disser "sexta", é a sexta desta semana; se disser "segunda", é a próxima segunda-feira).
5. Se nenhum horário for explicitado (ex: apenas "chega amanhã"), defina horario como null ou "08:00" caso comercial. Se for mencionado "de manhã", defina "08:00". Se "à tarde", defina "13:30".
6. Se a mensagem NÃO for um agendamento ou compromisso com data (ex: apenas "Bom dia", "Obrigado", "Valeu", "Cadê a chave?"), retorne is_agendamento: false.
7. O campo 'descricao' deve ser claro, objetivo, gramaticalmente correto em português brasileiro e sem ruídos (ex: "Entrega de persianas da sala", "Concretagem da laje 4º pavimento", "Vistoria dos Bombeiros").
`.trim();

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemInstruction,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            is_agendamento: { type: SchemaType.BOOLEAN },
            data_iso: { type: SchemaType.STRING, nullable: true },
            horario: { type: SchemaType.STRING, nullable: true },
            descricao: { type: SchemaType.STRING, nullable: true },
            categoria: { type: SchemaType.STRING, nullable: true },
          },
          required: ['is_agendamento', 'data_iso', 'horario', 'descricao'],
        },
      },
    });

    const result = await model.generateContent(`Mensagem a analisar:\n"${textoMensagem}"`);
    const outputRaw = result.response.text();
    if (!outputRaw) return fallbackSeguro;

    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      is_agendamento: Boolean(parsed.is_agendamento),
      data_iso: parsed.data_iso || null,
      horario: parsed.horario || null,
      descricao: parsed.descricao ? String(parsed.descricao).trim() : null,
      categoria: parsed.categoria || 'outro',
    };
  } catch (err) {
    console.error('[AI] Erro ao extrair agendamento com Gemini:', err);
    return fallbackSeguro;
  }
}

/**
 * Extrapolação Inteligente: Extração em Lote e Multi-Eventos
 * Processa textos externos arbitrários (SMS, e-mails de fornecedores, minutas, WhatsApp Web).
 */
export async function extrairMultiplosEventosTexto(
  textoLongo: string,
  dataAtualBase: string,
  obrasDisponiveis: Array<{ obra_id: string; nome_obra: string }> = []
): Promise<ResultadoExtracaoLote> {
  const fallback: ResultadoExtracaoLote = {
    sucesso: false,
    resumo_contexto: '',
    obra_detectada: null,
    eventos: [],
  };

  if (!textoLongo || textoLongo.trim().length === 0) {
    return fallback;
  }

  try {
    const listaObrasStr = obrasDisponiveis.length > 0
      ? obrasDisponiveis.map(o => `- "${o.nome_obra}" (ID: ${o.obra_id})`).join('\n')
      : 'Nenhuma obra pré-cadastrada fornecida.';

    const prompt = `
Você é um Analista Técnico de Operações e IA de Construção Civil.
Recebemos um texto colado pelo usuário (que pode ser um SMS de transportadora, e-mail de fornecedor, transcrição de áudio, aviso de condomínio ou mensagem solta).

SUA MISSÃO:
1. Ler o texto completo e identificar TODOS os eventos, entregas, vistorias ou serviços mencionados.
2. Converter todas as datas relativas com base na data de referência: HOJE É ${dataAtualBase}.
3. Tentar inferir se o texto cita ou remete a alguma das obras disponíveis no sistema:
${listaObrasStr}
4. Gerar uma lista estruturada de eventos prontos para serem inseridos no banco de dados.

Texto colado:
"""
${textoLongo}
"""
`.trim();

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            sucesso: { type: SchemaType.BOOLEAN },
            resumo_contexto: { type: SchemaType.STRING },
            obra_detectada: { type: SchemaType.STRING, nullable: true },
            eventos: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  data_iso: { type: SchemaType.STRING },
                  horario: { type: SchemaType.STRING, nullable: true },
                  descricao: { type: SchemaType.STRING },
                  categoria: { type: SchemaType.STRING },
                  confianca: { type: SchemaType.NUMBER },
                },
                required: ['data_iso', 'descricao', 'categoria', 'confianca'],
              },
            },
          },
          required: ['sucesso', 'resumo_contexto', 'eventos'],
        },
      },
    });

    const result = await model.generateContent(prompt);
    const outputRaw = result.response.text();
    if (!outputRaw) return fallback;

    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      sucesso: Boolean(parsed.sucesso),
      resumo_contexto: parsed.resumo_contexto || 'Texto processado com sucesso.',
      obra_detectada: parsed.obra_detectada || null,
      eventos: Array.isArray(parsed.eventos) ? parsed.eventos : [],
    };
  } catch (err) {
    console.error('[AI] Erro ao extrair múltiplos eventos:', err);
    return fallback;
  }
}

/**
 * Chat de Engenharia de Soluções & Gerador de Prompts para IDE
 * Transforma uma necessidade funcional do usuário em um Ticket com Prompt cirúrgico para a IDE.
 */
export async function gerarSolucaoEngenharia(
  descricaoNecessidade: string,
  historicoContexto: string = ''
): Promise<SolucaoEngenharia> {
  const agora = new Date();
  const ticketId = `TCK-${agora.getFullYear()}${String(agora.getMonth() + 1).padStart(2, '0')}${String(agora.getDate()).padStart(2, '0')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  try {
    const prompt = `
Você é o Arquiteto de Software Principal do ecossistema "GADAP Hub - Gestão de Obras via WhatsApp".
A stack do projeto é:
- Backend: Node.js (v20+), Express, TypeScript estrito, Supabase (@supabase/supabase-js), Baileys (@whiskeysockets/baileys), Google Gemini (@google/generative-ai).
- Frontend: Single Page Application Vanilla JS moderna em public/index.html com Tailwind CSS e FullCalendar.js.
- Arquitetura: Servidor Render com trava distribuída (system_locks) e despertar agendado via GitHub Actions.

O usuário descreveu uma necessidade de nova feature, melhoria ou relatório:
"""
${descricaoNecessidade}
"""

Contexto adicional / histórico recente:
${historicoContexto || 'Nenhum contexto prévio.'}

SUA MISSÃO:
Gere uma especificação técnica de alto nível e um PROMPT COMPLETO, PRECISO E PRONTO PARA SER COLADO DIRETAMENTE NA IDE (Antigravity/Cursor/Claude Code) para o agente de desenvolvimento implementar de ponta a ponta sem ambiguidades.
O prompt deve conter:
1. O Ticket de Início [${ticketId}] e os critérios de encerramento do Ticket.
2. Instruções explícitas de arquivos a modificar (src/server.ts, public/index.html, aiProcessor.ts, etc.).
3. Scripts SQL / DDL necessários para o Supabase, se aplicável.
4. Regras estritas de qualidade (npx tsc --noEmit, npm run build).
`.trim();

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            titulo_demanda: { type: SchemaType.STRING },
            categoria: { type: SchemaType.STRING },
            resumo_executivo: { type: SchemaType.STRING },
            especificacao_tecnica: {
              type: SchemaType.OBJECT,
              properties: {
                arquivos_afetados: {
                  type: SchemaType.ARRAY,
                  items: { type: SchemaType.STRING },
                },
                mudancas_backend: { type: SchemaType.STRING },
                mudancas_frontend: { type: SchemaType.STRING },
                queries_supabase_ddl: { type: SchemaType.STRING, nullable: true },
              },
              required: ['arquivos_afetados', 'mudancas_backend', 'mudancas_frontend'],
            },
            prompt_ide: { type: SchemaType.STRING },
            criterios_aceite: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
            },
          },
          required: [
            'titulo_demanda',
            'categoria',
            'resumo_executivo',
            'especificacao_tecnica',
            'prompt_ide',
            'criterios_aceite',
          ],
        },
      },
    });

    const result = await model.generateContent(prompt);
    const outputRaw = result.response.text();
    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      ticket_id: ticketId,
      titulo_demanda: parsed.titulo_demanda || 'Melhoria no GADAP Hub',
      categoria: parsed.categoria || 'relatorio',
      resumo_executivo: parsed.resumo_executivo || 'Implementação solicitada pelo usuário.',
      especificacao_tecnica: {
        arquivos_afetados: Array.isArray(parsed.especificacao_tecnica?.arquivos_afetados)
          ? parsed.especificacao_tecnica.arquivos_afetados
          : ['src/server.ts', 'public/index.html'],
        mudancas_backend: parsed.especificacao_tecnica?.mudancas_backend || '',
        mudancas_frontend: parsed.especificacao_tecnica?.mudancas_frontend || '',
        queries_supabase_ddl: parsed.especificacao_tecnica?.queries_supabase_ddl || null,
      },
      prompt_ide: parsed.prompt_ide || '',
      criterios_aceite: Array.isArray(parsed.criterios_aceite) ? parsed.criterios_aceite : [],
    };
  } catch (err: any) {
    console.error('[AI] Erro ao gerar solução de engenharia:', err);
    return {
      ticket_id: ticketId,
      titulo_demanda: 'Demanda de Engenharia (Fallback)',
      categoria: 'relatorio',
      resumo_executivo: 'Não foi possível sintetizar a demanda via IA.',
      especificacao_tecnica: {
        arquivos_afetados: ['src/server.ts'],
        mudancas_backend: 'Revisar logs do servidor.',
        mudancas_frontend: 'Sem alterações.',
      },
      prompt_ide: `Ticket [${ticketId}]: Implementar a seguinte melhoria:\n${descricaoNecessidade}`,
      criterios_aceite: ['Validação dos types do TypeScript.'],
    };
  }
}

/**
 * Validação de Conflito de Agenda (Detecção de interferência logística no canteiro)
 */
export async function detectarConflitosAgenda(
  novoEvento: { descricao: string; horario: string | null },
  eventosExistentesNoDia: Array<{ descricao: string; horario: string }>
): Promise<AnaliseConflito> {
  if (eventosExistentesNoDia.length === 0) {
    return { tem_conflito: false, motivo_conflito: null, sugestao: null };
  }

  try {
    const prompt = `
Analise se este novo evento de obra entra em conflito logístico, operacional ou de espaço com os eventos já agendados para o mesmo dia no mesmo canteiro:

NOVO EVENTO:
- Atividade: "${novoEvento.descricao}"
- Horário: ${novoEvento.horario || 'Não especificado'}

EVENTOS JÁ AGENDADOS NO DIA:
${eventosExistentesNoDia.map((ev, i) => `${i + 1}. Às ${ev.horario}: "${ev.descricao}"`).join('\n')}

Exemplos de conflito real:
- Concretagem de laje / caminhão bomba bloqueando entrada ao mesmo tempo que chegada de carreta de drywall/aço/persianas.
- Pintura ou aplicação de resina em área fechada no mesmo horário que instalação com poeira ou lixamento de piso.
- Sobreposição exata de horários para duas descargas pesadas no mesmo portão de acesso.

Se não houver incompatibilidade real de espaço ou tempo, defina tem_conflito como false.
`.trim();

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            tem_conflito: { type: SchemaType.BOOLEAN },
            motivo_conflito: { type: SchemaType.STRING, nullable: true },
            sugestao: { type: SchemaType.STRING, nullable: true },
          },
          required: ['tem_conflito', 'motivo_conflito', 'sugestao'],
        },
      },
    });

    const result = await model.generateContent(prompt);
    const outputRaw = result.response.text();
    if (!outputRaw) return { tem_conflito: false, motivo_conflito: null, sugestao: null };

    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      tem_conflito: Boolean(parsed.tem_conflito),
      motivo_conflito: parsed.motivo_conflito || null,
      sugestao: parsed.sugestao || null,
    };
  } catch (err) {
    console.error('[AI] Erro ao detectar conflitos de agenda:', err);
    return { tem_conflito: false, motivo_conflito: null, sugestao: null };
  }
}
