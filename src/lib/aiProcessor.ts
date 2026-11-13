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
    const diaSemana = isNaN(dataRefObj.getTime())
      ? ''
      : dataRefObj.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });

    const systemInstruction = `
Você é o assistente inteligente de gestão de canteiros de obras do ecossistema GADAP Hub.
Seu objetivo é analisar conversas de WhatsApp de equipes de obra e extrair agendamentos operacionais.

[DATA DE REFERÊNCIA DE HOJE]: ${dataAtualBase}${diaSemana ? ` (${diaSemana})` : ''}.

[CRITÉRIOS]:
1. is_agendamento:
   - TRUE se for entrega de material (persianas, vidros, cimento, pisos, gesso, ferragem), serviços/frentes de trabalho (concretagem, pintura, caçamba, hidráulica, elétrica) ou visitas/vistorias.
   - FALSE se for conversa informal, cumprimentos, dúvidas gerais ou relatos passados.

2. data_iso:
   - Calcule com precisão em relação à data de hoje ("hoje", "amanhã", "quarta que vem", "dia 20"). Formato: YYYY-MM-DD.

3. horario:
   - Formato HH:MM (24h) ou null se não houver horário especificado.

4. descricao:
   - Resumo curto e claro da atividade (ex: "Entrega de persianas e trilhos", "Concretagem da viga baldrame").

5. categoria:
   - 'entrega', 'servico', 'vistoria' ou 'outro'.
`.trim();

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction,
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

    const result = await model.generateContent(textoMensagem);
    const outputRaw = result.response.text();
    if (!outputRaw) return fallbackSeguro;

    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      is_agendamento: Boolean(parsed.is_agendamento),
      data_iso: parsed.data_iso || null,
      horario: parsed.horario || null,
      descricao: parsed.descricao || null,
      categoria: parsed.categoria || null,
    };
  } catch (error) {
    console.error('[AI] Erro ao extrair agendamento:', error);
    return fallbackSeguro;
  }
}

/**
 * Avalia se o novo agendamento gera conflito logístico ou operacional
 * com outros eventos já marcados para o mesmo dia no canteiro da obra.
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
