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
}

/**
 * Processador de Linguagem Natural baseado no Google Gemini para identificação e
 * extração estruturada de compromissos operacionais em obras (GADAP Hub).
 *
 * @param textoMensagem Conteúdo textual da mensagem recebida no WhatsApp.
 * @param dataAtualBase Data de referência no formato "YYYY-MM-DD" para resolução temporal.
 * @returns Objeto estruturado conforme a interface ResultadoAgendamento.
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
  };

  if (!textoMensagem || textoMensagem.trim().length === 0) {
    return fallbackSeguro;
  }

  try {
    // Calcula o dia da semana a partir da data de referência para orientar a IA
    const dataRefObj = new Date(`${dataAtualBase}T12:00:00Z`);
    const diaSemana = isNaN(dataRefObj.getTime())
      ? ''
      : dataRefObj.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });

    const systemInstruction = `
Você é o assistente de inteligência artificial responsável pela gestão de obras do ecossistema GADAP Hub.
Seu papel é analisar mensagens de texto trocadas em grupos de WhatsApp de canteiros de obras e extrair exclusivamente compromissos, tarefas futuras e agendamentos operacionais.

[DATA DE REFERÊNCIA DE HOJE]: ${dataAtualBase}${diaSemana ? ` (${diaSemana})` : ''}.

[CRITÉRIOS DE AVALIAÇÃO]:
1. is_agendamento:
   - Defina como TRUE apenas se a mensagem indicar claramente um compromisso, entrega ou serviço programado para uma data futura ou para o próprio dia (ex: chegada de caminhão betoneira/bomba, entrega de materiais como pisos, persianas, esquadrias, gesso, cimento; visitas de engenheiros, vistorias técnicas, ensaios de concreto, medições de bancadas).
   - Defina como FALSE se for conversa informal, cumprimentos ("bom dia", "valeu"), dúvidas pontuais, fotos sem descrição de agendamento ou notificações de eventos que já aconteceram no passado.

2. data_iso:
   - Calcule a data exata com base na [DATA DE REFERÊNCIA DE HOJE].
   - Resolva termos relativos com precisão: "hoje", "amanhã", "depois de amanhã", "segunda-feira que vem", "dia 25".
   - Formato obrigatório: "YYYY-MM-DD". Se não for agendamento ou não houver data determinável, retorne null.

3. horario:
   - Extraia o horário específico mencionado (ex: "às 14h" -> "14:00", "09:30", "no final da tarde por volta das 17h" -> "17:00").
   - Se a mensagem marcar um dia específico mas não citar horário, defina como null.
   - Formato obrigatório: "HH:MM" (padrão 24 horas) ou null.

4. descricao:
   - Resumo conciso, direto e objetivo do compromisso agendado (ex: "Entrega de persianas", "Concretagem da laje do 2º pavimento", "Vistoria técnica da construtora").
   - Se não for agendamento, retorne null.

Você deve responder RIGOROSAMENTE através do schema JSON exigido, sem adicionar blocos de markdown ou comentários.
`.trim();

    // Utiliza o modelo gemini-1.5-flash com schema JSON restritivo
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            is_agendamento: {
              type: SchemaType.BOOLEAN,
              description: 'True se for um compromisso de obra futuro/programado, false caso contrário',
            },
            data_iso: {
              type: SchemaType.STRING,
              nullable: true,
              description: 'Data do evento no formato YYYY-MM-DD ou null',
            },
            horario: {
              type: SchemaType.STRING,
              nullable: true,
              description: 'Horário do evento no formato HH:MM (24h) ou null',
            },
            descricao: {
              type: SchemaType.STRING,
              nullable: true,
              description: 'Descrição resumida e clara do evento ou null',
            },
          },
          required: ['is_agendamento', 'data_iso', 'horario', 'descricao'],
        },
      },
    });

    const result = await model.generateContent(textoMensagem);
    const outputRaw = result.response.text();

    if (!outputRaw) {
      return fallbackSeguro;
    }

    // Limpa eventuais marcações de código caso o modelo insira
    const limpo = outputRaw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(limpo);

    return {
      is_agendamento: Boolean(parsed.is_agendamento),
      data_iso: parsed.data_iso || null,
      horario: parsed.horario || null,
      descricao: parsed.descricao || null,
    };
  } catch (error) {
    console.error('[AI] Erro ao extrair agendamento com Gemini:', error);
    return fallbackSeguro;
  }
}
