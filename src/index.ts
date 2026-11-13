import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import dotenv from 'dotenv';

import { useSupabaseAuthState, supabase } from './lib/useSupabaseAuthState';
import { processarMensagemComIA } from './lib/aiProcessor';

dotenv.config();

const OBRA_GROUP_ID = process.env.OBRA_GROUP_ID || '';
const OBRA_ID = process.env.OBRA_ID || 'obra_principal';
const EXECUTION_TIMEOUT_MS = 60 * 1000; // Janela efêmera de 60 segundos

let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;

// ==============================================================================
// Funções Auxiliares de Banco de Dados (Supabase)
// ==============================================================================

async function jaProcessouMensagem(messageId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('mensagens_processadas')
    .select('message_id')
    .eq('message_id', messageId)
    .maybeSingle();

  if (error) {
    console.error(`[DB] Erro ao checar mensagem ${messageId}:`, error.message);
    return false;
  }
  return !!data;
}

async function registrarMensagemProcessada(messageId: string, remoteJid: string): Promise<void> {
  const { error } = await supabase
    .from('mensagens_processadas')
    .insert([{ message_id: messageId, remote_jid: remoteJid }]);

  if (error && error.code !== '23505') {
    console.error(`[DB] Erro ao registrar mensagem ${messageId}:`, error.message);
  }
}

async function salvarAgendamento(dataEvento: string, horario: string, descricao: string): Promise<boolean> {
  const { error } = await supabase
    .from('agenda_obra')
    .insert([{
      obra_id: OBRA_ID,
      data_evento: dataEvento,
      horario: horario,
      descricao: descricao,
    }]);

  if (error) {
    console.error('[DB] Erro ao inserir evento na agenda_obra:', error.message);
    return false;
  }
  return true;
}

async function relatorioJaEnviado(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('disparos_executados')
    .select('id')
    .eq('tipo_disparo', tipo)
    .eq('referencia_data', dataRef)
    .maybeSingle();

  if (error) {
    console.error(`[DB] Erro ao checar envio de relatório ${tipo}:`, error.message);
    return false;
  }
  return !!data;
}

async function marcarRelatorioEnviado(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<void> {
  const { error } = await supabase
    .from('disparos_executados')
    .insert([{ tipo_disparo: tipo, referencia_data: dataRef }]);

  if (error && error.code !== '23505') {
    console.error(`[DB] Erro ao registrar envio do relatório ${tipo}:`, error.message);
  }
}

// ==============================================================================
// Lógica de Relatórios da Obra
// ==============================================================================

async function processarRelatorios(client: WASocket): Promise<void> {
  if (!OBRA_GROUP_ID) {
    console.warn('[Relatórios] OBRA_GROUP_ID não definido. Disparos ignorados.');
    return;
  }

  const agora = new Date();
  const diaSemana = agora.getDay(); // 0 = Dom, 1 = Seg, 2 = Ter, ..., 5 = Sex, 6 = Sáb
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Relatórios] Verificando agendamentos automáticos: Dia=${diaSemana}, Hora=${hora}h`);

  // 1. Segunda-feira pela manhã (entre 07:00 e 11:59): Relatório Semanal
  if (diaSemana === 1 && hora >= 7 && hora <= 11) {
    const jaEnviado = await relatorioJaEnviado('SEMANAL', hojeIso);
    if (!jaEnviado) {
      console.log('📊 [Relatório Semanal] Compilando agenda da semana...');
      const em5Dias = new Date();
      em5Dias.setDate(agora.getDate() + 5);
      const dataFimIso = em5Dias.toISOString().split('T')[0];

      const { data: eventos, error } = await supabase
        .from('agenda_obra')
        .select('*')
        .eq('obra_id', OBRA_ID)
        .gte('data_evento', hojeIso)
        .lte('data_evento', dataFimIso)
        .order('data_evento', { ascending: true })
        .order('horario', { ascending: true });

      if (!error) {
        let mensagem = '📋 *AGENDA DA SEMANA - GADAP HUB*\n_Previsão dos próximos 5 dias de obra:_\n\n';
        if (!eventos || eventos.length === 0) {
          mensagem += 'Nenhum agendamento cadastrado para os próximos dias.\nTenham todos uma excelente semana de trabalho!';
        } else {
          eventos.forEach((ev) => {
            const [ano, mes, dia] = ev.data_evento.split('-');
            mensagem += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
          });
          mensagem += 'Qualquer alteração ou novo fornecedor, informem neste grupo.';
        }

        await client.sendMessage(OBRA_GROUP_ID, { text: mensagem });
        await marcarRelatorioEnviado('SEMANAL', hojeIso);
        console.log('✅ Relatório Semanal disparado e registrado no Supabase!');
      }
    } else {
      console.log('[Relatório Semanal] Já disparado anteriormente hoje.');
    }
  }

  // 2. Terça a Sexta pela manhã (entre 06:00 e 09:59): Relatório Diário
  if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
    const jaEnviado = await relatorioJaEnviado('DIARIO', hojeIso);
    if (!jaEnviado) {
      console.log('🌅 [Relatório Diário] Compilando compromissos do dia...');
      const { data: eventos, error } = await supabase
        .from('agenda_obra')
        .select('*')
        .eq('obra_id', OBRA_ID)
        .eq('data_evento', hojeIso)
        .order('horario', { ascending: true });

      if (!error) {
        let mensagem = '🌅 *LEMBRETES DO DIA - GADAP HUB*\n_Atividades e entregas programadas para hoje:_\n\n';
        if (!eventos || eventos.length === 0) {
          mensagem += 'Nenhum compromisso ou entrega de material prevista para hoje. Bom expediente!';
        } else {
          eventos.forEach((ev) => {
            mensagem += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
          });
          mensagem += '\nFiquem atentos aos recebimentos e frentes de serviço!';
        }

        await client.sendMessage(OBRA_GROUP_ID, { text: mensagem });
        await marcarRelatorioEnviado('DIARIO', hojeIso);
        console.log('✅ Relatório Diário disparado e registrado no Supabase!');
      }
    } else {
      console.log('[Relatório Diário] Já disparado anteriormente hoje.');
    }
  }
}

// ==============================================================================
// Processamento de Mensagens
// ==============================================================================

async function processarMensagemIndividual(msg: proto.IWebMessageInfo, client: WASocket) {
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!remoteJid || !messageId) return;

  // Filtra apenas mensagens do grupo configurado
  if (OBRA_GROUP_ID && remoteJid !== OBRA_GROUP_ID) {
    return;
  }

  // Deduplicação: verifica se a mensagem já foi lida
  const processada = await jaProcessouMensagem(messageId);
  if (processada) {
    return;
  }

  // Extrai o conteúdo em texto da mensagem
  const texto =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption;

  if (!texto || texto.trim().length === 0) {
    await registrarMensagemProcessada(messageId, remoteJid);
    return;
  }

  console.log(`[Mensagem Nova Recebida]: "${texto}"`);

  // Envia para o processador de IA
  const resultado = await processarMensagemComIA(texto);

  if (resultado.is_agendamento) {
    console.log('🎯 [Agendamento Confirmado pela IA]:', resultado);
    const salvo = await salvarAgendamento(resultado.data_iso, resultado.horario, resultado.descricao);

    if (salvo) {
      try {
        await client.sendMessage(remoteJid, {
          react: { text: '📅', key: msg.key },
        });
        console.log('✨ Reação de calendário 📅 enviada no WhatsApp!');
      } catch (err) {
        console.error('Erro ao enviar reação no WhatsApp:', err);
      }
    }
  }

  // Marca como processada para nunca reprocessar
  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// Motor Principal e Graceful Shutdown
// ==============================================================================

async function iniciarBotServerless() {
  console.log('🚀 [GADAP Hub Bot] Inicializando runner efêmero...');

  const { state, saveCreds } = await useSupabaseAuthState();
  saveCredsFn = saveCreds;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => {
    if (saveCredsFn) await saveCredsFn();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Se a sessão ainda não existir no banco (primeira execução local)
    if (qr) {
      console.log('\n======================================================');
      console.log('⚡ SESSÃO NÃO ENCONTRADA. ESCANEIE O QR CODE ABAIXO:');
      qrcode.generate(qr, { small: true });
      console.log('======================================================\n');
    }

    if (connection === 'open') {
      console.log('✅ [WhatsApp] Conexão autenticada e aberta com sucesso!');
      if (sock) {
        await processarRelatorios(sock);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[WhatsApp] Conexão fechada com statusCode: ${statusCode}`);
    }
  });

  // Mensagens recebidas ou não lidas durante a sincronização
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  // Histórico de sincronização
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[Histórico] Sincronizando ${messages.length} mensagens...`);
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  // Timeout preventivo de 60 segundos para Graceful Shutdown
  setTimeout(async () => {
    console.log(`\n⏱️ [Timeout ${EXECUTION_TIMEOUT_MS / 1000}s] Iniciando Graceful Shutdown...`);
    try {
      if (saveCredsFn) {
        await saveCredsFn();
        console.log('💾 Estado de autenticação consolidado no Supabase.');
      }
      if (sock) {
        sock.end(undefined);
        console.log('🔌 Socket Baileys desconectado.');
      }
    } catch (err) {
      console.error('Erro durante o shutdown:', err);
    } finally {
      console.log('🏁 Ciclo finalizado com sucesso. Encerrando processo...');
      process.exit(0);
    }
  }, EXECUTION_TIMEOUT_MS);
}

iniciarBotServerless().catch((err) => {
  console.error('FATAL: Erro não tratado no runner serverless:', err);
  process.exit(1);
});
