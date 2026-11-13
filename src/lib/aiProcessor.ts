import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export interface AgendamentoObraExtracao {
  is_agendamento: boolean;
  data_iso: string; // Formato YYYY-MM-DD
  horario: string;  // Formato HH:MM (24h)
  descricao: string;
}

/**
 * Processador de Linguagem Natural usando Google Gemini SDK com saída estruturada estrita.
 * Analisa mensagens de grupos de obras do ecossistema GADAP Hub para extrair agendamentos.
 */
export async function processarMensagemComIA(textoBruto: string): Promise<AgendamentoObraExtracao> {
  const agora = new Date();
  const hojeIso = agora.toISOString().split('T')[0];
  const diaSemana = agora.toLocaleDateString('pt-BR', { weekday: 'long' });

  const systemInstruction = `
Você é o assistente inteligente de gestão de obras do ecossistema GADAP Hub.
Seu objetivo é extrair rigorosamente agendamentos e compromissos operacionais a partir de mensagens enviadas no grupo de WhatsApp da obra.

Exemplos de compromissos de obra:
- Entrega de materiais (ex: cimento, areia, porcelanato, gesso, persiana, esquadrias).
- Serviços e visitas técnicas (ex: concretagem, pintura, vistoria de engenharia, medição de bancada).
- Chegada de caminhão, bomba ou caçamba.

Instruções temporais:
- Considere a data atual como referência: ${hojeIso} (${diaSemana}).
- Interprete expressões relativas: "hoje", "amanhã", "depois de amanhã", "segunda-feira que vem", etc.
- Se nenhum horário específico for citado, assuma "08:00" como horário padrão do início de expediente na obra.
- Se a mensagem NÃO for um compromisso futuro (ex: saudações, conversas paralelas, dúvidas, avisos passados), defina is_agendamento como false e deixe os demais campos como string vazia.

Você DEVE responder única e exclusivamente no schema JSON definido.
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
              description: 'True se a mensagem contém um agendamento ou entrega para a obra',
            },
            data_iso: {
              type: SchemaType.STRING,
              description: 'Data do evento no formato YYYY-MM-DD',
            },
            horario: {
              type: SchemaType.STRING,
              description: 'Horário do evento no formato HH:MM (24h)',
            },
            descricao: {
              type: SchemaType.STRING,
              description: 'Descrição objetiva e clara do agendamento ou material',
            },
          },
          required: ['is_agendamento', 'data_iso', 'horario', 'descricao'],
        },
      },
    });

    const result = await model.generateContent(textoBruto);
    const responseText = result.response.text();

    if (!responseText) {
      return { is_agendamento: false, data_iso: '', horario: '', descricao: '' };
    }

    const parsed: AgendamentoObraExtracao = JSON.parse(responseText);
    return {
      is_agendamento: Boolean(parsed.is_agendamento),
      data_iso: parsed.data_iso || '',
      horario: parsed.horario || '',
      descricao: parsed.descricao || '',
    };
  } catch (err) {
    console.error('[AI Processor] Falha ao processar mensagem via Gemini:', err);
    return { is_agendamento: false, data_iso: '', horario: '', descricao: '' };
  }
}

