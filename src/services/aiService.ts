import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { config } from '../config/env';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export interface ExtracaoAgendamento {
  is_agendamento: boolean;
  data_iso: string; // "YYYY-MM-DD"
  horario: string;  // "HH:MM"
  descricao: string;
}

/**
 * Processa a mensagem de texto via Gemini para identificar se é agendamento e extrair dados estruturados.
 */
export async function extrairAgendamentoComIA(texto: string): Promise<ExtracaoAgendamento> {
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];
  const diaSemana = hoje.toLocaleDateString('pt-BR', { weekday: 'long' });

  const systemInstruction = `
Você é um assistente especialista em gerenciamento de obras e agendamentos.
Seu objetivo é analisar mensagens de bate-papo de um grupo de WhatsApp de obra e extrair compromissos, agendamentos, entregas de materiais, visitas técnicas, concretagem, vistorias, etc.

Considere a data atual como referência: ${hojeIso} (${diaSemana}).
Interprete termos relativos como:
- "hoje", "amanhã", "depois de amanhã"
- dias da semana como "segunda", "quinta que vem"
- horários como "às 14h", "às 9 da manhã", "10:30" (se não especificado horário, use "08:00" como padrão comercial de obra).

Se a mensagem NÃO contiver intenção de agendamento ou tarefa futura com data/horário (ex: apenas uma conversa informal, foto sem descrição de agendamento, cumprimento), marque is_agendamento como false e retorne campos vazios.

Você DEVE responder rigorosamente no formato JSON.
`.trim();

  try {
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
              description: 'Indica se a mensagem é um agendamento ou compromisso de obra',
            },
            data_iso: {
              type: SchemaType.STRING,
              description: 'Data do evento no formato YYYY-MM-DD',
            },
            horario: {
              type: SchemaType.STRING,
              description: 'Horário do evento no formato HH:MM (24 horas)',
            },
            descricao: {
              type: SchemaType.STRING,
              description: 'Descrição concisa e objetiva da atividade ou entrega agendada',
            },
          },
          required: ['is_agendamento', 'data_iso', 'horario', 'descricao'],
        },
      },
    });

    const result = await model.generateContent(texto);
    const outputText = result.response.text();

    if (!outputText) {
      return { is_agendamento: false, data_iso: '', horario: '', descricao: '' };
    }

    const resultado: ExtracaoAgendamento = JSON.parse(outputText);
    return resultado;
  } catch (error) {
    console.error('Erro na chamada da IA (Gemini):', error);
    return { is_agendamento: false, data_iso: '', horario: '', descricao: '' };
  }
}
