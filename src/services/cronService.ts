import cron from 'node-cron';
import { WASocket } from '@whiskeysockets/baileys';
import { buscarEventosPorIntervalo, buscarEventosDoDia } from './supabaseService';
import { config } from '../config/env';

/**
 * Formata lista de eventos para envio no WhatsApp.
 */
function formatarMensagemSemanal(eventos: any[]): string {
  if (eventos.length === 0) {
    return '📋 *Agenda da Semana - Obra*\n\nNenhum agendamento programado para os próximos 5 dias. Tenham uma ótima semana!';
  }

  let mensagem = '📋 *AGENDA DA SEMANA - OBRA*\n_Previsão dos próximos 5 dias:_\n\n';
  eventos.forEach((ev) => {
    const [ano, mes, dia] = ev.data_evento.split('-');
    mensagem += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
  });

  mensagem += 'Dúvidas ou alterações, favor avisar por aqui!';
  return mensagem;
}

/**
 * Formata lista de eventos do dia para envio no WhatsApp.
 */
function formatarMensagemDiaria(eventos: any[]): string {
  if (eventos.length === 0) {
    return '🌅 *Lembretes do Dia - Obra*\n\nNenhum compromisso ou entrega agendada para hoje. Bom trabalho a todos!';
  }

  let mensagem = '🌅 *LEMBRETES DO DIA - OBRA*\n_Atividades e entregas programadas para hoje:_\n\n';
  eventos.forEach((ev) => {
    mensagem += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
  });

  mensagem += '\nFiquem atentos aos horários!';
  return mensagem;
}

/**
 * Inicializa as rotinas cron para envios automáticos no grupo da obra.
 */
export function inicializarCron(getSock: () => WASocket | null) {
  // 1. Toda Segunda-feira às 09:00: Agenda da Semana (próximos 5 dias)
  // Expressão cron: '0 9 * * 1' -> Minuto 0, Hora 9, qualquer dia do mês, qualquer mês, 1 = Segunda
  cron.schedule('0 9 * * 1', async () => {
    console.log('[CRON] Executando rotina de Agenda da Semana (Segunda-feira 09:00)...');
    const sock = getSock();
    if (!sock || !config.obraGroupId) {
      console.warn('[CRON] Socket não conectado ou OBRA_GROUP_ID não configurado.');
      return;
    }

    try {
      const hoje = new Date();
      const em5Dias = new Date();
      em5Dias.setDate(hoje.getDate() + 5);

      const dataInicio = hoje.toISOString().split('T')[0];
      const dataFim = em5Dias.toISOString().split('T')[0];

      const eventos = await buscarEventosPorIntervalo(config.obraId, dataInicio, dataFim);
      const mensagem = formatarMensagemSemanal(eventos);

      await sock.sendMessage(config.obraGroupId, { text: mensagem });
      console.log('[CRON] Mensagem da agenda semanal enviada com sucesso!');
    } catch (err) {
      console.error('[CRON] Erro ao disparar agenda semanal:', err);
    }
  });

  // 2. Terça a Sexta às 07:00: Lembretes do Dia
  // Expressão cron: '0 7 * * 2-5' -> Minuto 0, Hora 7, 2-5 = Terça a Sexta
  cron.schedule('0 7 * * 2-5', async () => {
    console.log('[CRON] Executando rotina de Lembretes do Dia (Terça a Sexta 07:00)...');
    const sock = getSock();
    if (!sock || !config.obraGroupId) {
      console.warn('[CRON] Socket não conectado ou OBRA_GROUP_ID não configurado.');
      return;
    }

    try {
      const hojeIso = new Date().toISOString().split('T')[0];
      const eventos = await buscarEventosDoDia(config.obraId, hojeIso);
      const mensagem = formatarMensagemDiaria(eventos);

      await sock.sendMessage(config.obraGroupId, { text: mensagem });
      console.log('[CRON] Mensagem de lembretes diários enviada com sucesso!');
    } catch (err) {
      console.error('[CRON] Erro ao disparar lembretes do dia:', err);
    }
  });

  console.log('⏰ Rotinas cron agendadas:');
  console.log('   - Segunda-feira às 09:00 (Agenda dos próximos 5 dias)');
  console.log('   - Terça a Sexta às 07:00 (Lembretes do dia)');
}

