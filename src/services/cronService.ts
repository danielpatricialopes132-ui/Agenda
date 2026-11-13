import { WASocket } from '@whiskeysockets/baileys';
import { config } from '../config/env';
import {
  buscarEventosPorIntervalo,
  buscarEventosDoDia,
  disparoJaRealizado,
  registrarDisparo,
} from './supabaseService';

/**
 * Avalia as janelas de horário e dispara lembretes caso ainda não tenham sido enviados no dia.
 */
export async function processarDisparosProgramados(sock: WASocket): Promise<void> {
  if (!config.obraGroupId) {
    console.warn('[Disparos] OBRA_GROUP_ID não definido. Pulando disparos.');
    return;
  }

  const agora = new Date();
  const diaSemana = agora.getDay(); // 0: Domingo, 1: Segunda, ..., 5: Sexta, 6: Sábado
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Disparos] Verificando janelas: Dia da semana = ${diaSemana}, Hora = ${hora}:00, Data = ${hojeIso}`);

  // 1. Segunda-feira entre 08:00 e 11:00 (Agenda da semana dos próximos 5 dias)
  if (diaSemana === 1 && hora >= 8 && hora <= 11) {
    const jaEnviado = await disparoJaRealizado('SEMANAL', hojeIso);
    if (!jaEnviado) {
      console.log('[Disparos] Executando disparo de Agenda da Semana...');
      const em5Dias = new Date();
      em5Dias.setDate(agora.getDate() + 5);
      const dataFim = em5Dias.toISOString().split('T')[0];

      const eventos = await buscarEventosPorIntervalo(config.obraId, hojeIso, dataFim);
      let mensagem = '📋 *AGENDA DA SEMANA - OBRA*\n_Previsão dos próximos 5 dias:_\n\n';

      if (eventos.length === 0) {
        mensagem += 'Nenhum agendamento programado para os próximos dias. Bom trabalho a todos!';
      } else {
        eventos.forEach((ev) => {
          const [ano, mes, dia] = ev.data_evento.split('-');
          mensagem += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
        });
        mensagem += 'Dúvidas ou atualizações, favor avisar no grupo!';
      }

      await sock.sendMessage(config.obraGroupId, { text: mensagem });
      await registrarDisparo('SEMANAL', hojeIso);
      console.log('✅ Agenda da semana enviada e registrada no Supabase!');
    } else {
      console.log('[Disparos] Agenda da semana já foi enviada hoje.');
    }
  }

  // 2. Terça a Sexta entre 06:00 e 09:00 (Lembretes do dia)
  if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
    const jaEnviado = await disparoJaRealizado('DIARIO', hojeIso);
    if (!jaEnviado) {
      console.log('[Disparos] Executando disparo de Lembretes do Dia...');
      const eventos = await buscarEventosDoDia(config.obraId, hojeIso);
      let mensagem = '🌅 *LEMBRETES DO DIA - OBRA*\n_Atividades e entregas programadas para hoje:_\n\n';

      if (eventos.length === 0) {
        mensagem += 'Nenhum compromisso ou entrega agendada para hoje. Tenham um excelente dia de trabalho!';
      } else {
        eventos.forEach((ev) => {
          mensagem += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
        });
        mensagem += '\nFiquem atentos aos horários das frentes de serviço!';
      }

      await sock.sendMessage(config.obraGroupId, { text: mensagem });
      await registrarDisparo('DIARIO', hojeIso);
      console.log('✅ Lembretes do dia enviados e registrados no Supabase!');
    } else {
      console.log('[Disparos] Lembretes do dia já foram enviados hoje.');
    }
  }
}
