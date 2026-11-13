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
import { extrairAgendamento } from './lib/aiProcessor';

dotenv.config();

const OBRA_GROUP_ID = process.env.OBRA_GROUP_ID || '';
const OBRA_ID = process.env.OBRA_ID || 'obra_principal';
const EXECUTION_TIMEOUT_MS = 60 * 1000; // Janela efêmera máxima de 60 segundos

let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;
let shutdownTriggered = false;

// ==============================================================================
// 1. Operações no Banco de Dados (Supabase) com Tratamento e Logs Estruturados
// ==============================================================================

/**
 * Consulta se uma mensagem específica já foi processada anteriormente.
 */
async function jaProcessouMensagem(messageId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('mensagens_processadas')
      .select('message_id')
      .eq('message_id', messageId)
      .maybeSingle();

    if (error) {
      console.error(`[DB] Erro ao consultar mensagem_id "${messageId}":`, error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.error(`[DB] Exceção ao checar mensagem "${messageId}":`, err);
    return false;
  }
}

/**
 * Registra uma mensagem na tabela de deduplicação mensagens_processadas.
 */
async function registrarMensagemProcessada(messageId: string, remoteJid: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('mensagens_processadas')
      .insert([{ message_id: messageId, remote_jid: remoteJid }]);

    if (error && error.code !== '23505') {
      console.error(`[DB] Falha ao registrar mensagem processada "${messageId}":`, error.message);
    }
  } catch (err) {
    console.error(`[DB] Exceção ao inserir mensagem_processada "${messageId}":`, err);
  }
}

/**
 * Salva um compromisso confirmado na tabela agenda_obra.
 */
async function salvarAgendamento(dataEvento: string, horario: string | null, descricao: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('agenda_obra')
      .insert([
        {
          obra_id: OBRA_ID,
          data_evento: dataEvento,
          horario: horario || '08:00',
          descricao: descricao,
        },
      ]);

    if (error) {
      console.error('[DB] Erro ao gravar evento em agenda_obra:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[DB] Exceção ao salvar na agenda_obra:', err);
    return false;
  }
}

/**
 * Verifica idempotência dos relatórios (evita múltiplos envios no mesmo dia/janela).
 */
async function relatorioJaEnviado(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('disparos_executados')
      .select('id')
      .eq('tipo_disparo', tipo)
      .eq('referencia_data', dataRef)
      .maybeSingle();

    if (error) {
      // Se a tabela ainda não existir, apenas avisa sem quebrar o fluxo
      console.warn(`[DB] Não foi possível verificar disparos_executados (${tipo}):`, error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn(`[DB] Exceção ao verificar tabela disparos_executados:`, err);
    return false;
  }
}

/**
 * Marca o envio do relatório para garantir idempotência.
 */
async function marcarRelatorioEnviado(tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('disparos_executados')
      .insert([{ tipo_disparo: tipo, referencia_data: dataRef }]);

    if (error && error.code !== '23505') {
      console.warn(`[DB] Não foi possível registrar disparo ${tipo}:`, error.message);
    }
  } catch (err) {
    console.warn(`[DB] Exceção ao registrar disparo executado:`, err);
  }
}

// ==============================================================================
// 2. Motor de Disparos de Relatórios Periódicos
// ==============================================================================

async function processarRelatorios(client: WASocket): Promise<void> {
  if (!OBRA_GROUP_ID) {
    console.warn('[Relatórios] OBRA_GROUP_ID não configurado. Disparos ignorados.');
    return;
  }

  const agora = new Date();
  const diaSemana = agora.getDay(); // 0: Dom, 1: Seg, 2: Ter, 3: Qua, 4: Qui, 5: Sex, 6: Sáb
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Relatórios] Analisando regras de envio: Dia=${diaSemana}, Hora=${hora}h, Data=${hojeIso}`);

  // Regra 1: Segunda-feira pela manhã (entre 07:00 e 11:59) - Agenda da Semana
  if (diaSemana === 1 && hora >= 7 && hora <= 11) {
    const jaEnviado = await relatorioJaEnviado('SEMANAL', hojeIso);
    if (!jaEnviado) {
      console.log('📋 [Relatório Semanal] Compilando eventos dos próximos 5 dias...');
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
        console.log('✅ [Relatórios] Agenda da semana enviada e registrada com sucesso!');
      }
    } else {
      console.log('[Relatórios] Agenda da semana já enviada anteriormente hoje.');
    }
  }

  // Regra 2: Terça a Sexta pela manhã (entre 06:00 e 09:59) - Lembretes do Dia
  if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
    const jaEnviado = await relatorioJaEnviado('DIARIO', hojeIso);
    if (!jaEnviado) {
      console.log('🌅 [Relatório Diário] Compilando compromissos agendados para hoje...');
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
        console.log('✅ [Relatórios] Lembretes do dia enviados e registrados com sucesso!');
      }
    } else {
      console.log('[Relatórios] Lembretes do dia já enviados anteriormente hoje.');
    }
  }
}

// ==============================================================================
// 3. Processamento Individual e Deduplicação de Mensagens
// ==============================================================================

async function processarMensagemIndividual(msg: proto.IWebMessageInfo, client: WASocket): Promise<void> {
  // Ignora mensagens enviadas pelo próprio bot
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!remoteJid || !messageId) return;

  // Filtra exclusivamente o grupo configurado
  if (OBRA_GROUP_ID && remoteJid !== OBRA_GROUP_ID) {
    return;
  }

  // Deduplicação: checa se já foi processada no Supabase
  const processada = await jaProcessouMensagem(messageId);
  if (processada) {
    return;
  }

  // Extrai o texto da mensagem (mensagens diretas, respostas ou mídias com legenda)
  const texto =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption;

  if (!texto || texto.trim().length === 0) {
    // Marca como lida para não analisar mensagens vazias repetidamente
    await registrarMensagemProcessada(messageId, remoteJid);
    return;
  }

  console.log(`[WhatsApp] Mensagem recebida no grupo da obra: "${texto}"`);

  // Extração via IA (Gemini) com base na data de hoje
  const hojeIso = new Date().toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log('🎯 [AI] Agendamento identificado com sucesso:', resultado);
    const salvo = await salvarAgendamento(resultado.data_iso, resultado.horario, resultado.descricao);

    if (salvo) {
      try {
        // Reage à mensagem do usuário com emoji de calendário "📅"
        await client.sendMessage(remoteJid, {
          react: { text: '📅', key: msg.key },
        });
        console.log('✨ [WhatsApp] Reação 📅 enviada para a mensagem original!');
      } catch (err) {
        console.error('[WhatsApp] Falha ao reagir à mensagem:', err);
      }
    }
  }

  // Registra a mensagem na tabela de deduplicação
  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// 4. Fluxo de Inicialização e Graceful Shutdown
// ==============================================================================

async function realizarGracefulShutdown(motivo: string) {
  if (shutdownTriggered) return;
  shutdownTriggered = true;

  console.log(`\n⏳ [Shutdown] Iniciando encerramento gracioso (${motivo})...`);
  try {
    if (saveCredsFn) {
      await saveCredsFn();
      console.log('[DB] Credenciais do Baileys consolidadas no Supabase.');
    }
    if (sock) {
      sock.end(undefined);
      console.log('[WhatsApp] Conexão do socket finalizada.');
    }
  } catch (err) {
    console.error('[Shutdown] Erro ao consolidar sessão durante shutdown:', err);
  } finally {
    console.log('👋 [GADAP Hub] Ciclo efêmero concluído. Encerrando processo...');
    process.exit(0);
  }
}

async function main() {
  console.log('🚀 [GADAP Hub Bot] Inicializando runner serverless efêmero...');

  // 1. Inicializa com o adaptador useSupabaseAuthState
  const { state, saveCreds } = await useSupabaseAuthState('obra_principal');
  saveCredsFn = saveCreds;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  // Atualização contínua de credenciais
  sock.ev.on('creds.update', async () => {
    if (saveCredsFn) {
      await saveCredsFn();
    }
  });

  // Evento de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Se a sessão não existir (primeira inicialização local), exibe o QR Code
    if (qr) {
      console.log('\n======================================================');
      console.log('⚡ SESSÃO NÃO ENCONTRADA. ESCANEIE O QR CODE ABAIXO:');
      qrcode.generate(qr, { small: true });
      console.log('======================================================\n');
    }

    if (connection === 'open') {
      console.log('✅ [WhatsApp] Conectado e autenticado com sucesso!');
      if (sock) {
        await processarRelatorios(sock);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[WhatsApp] Conexão encerrada. Código de status: ${statusCode}`);
      // Se for logout explícito do dispositivo
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Dispositivo desconectado (loggedOut). Novo QR Code necessário.');
      }
    }
  });

  // Mensagens recebidas em tempo real ou pendentes na fila
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  // Mensagens sincronizadas pelo histórico do WhatsApp
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[WhatsApp] Histórico de mensagens recebido (${messages.length} mensagens). Sincronizando...`);
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  // Timeout fixo de 60 segundos para desligamento controlado
  setTimeout(() => {
    realizarGracefulShutdown(`Timeout de ${EXECUTION_TIMEOUT_MS / 1000}s atingido`);
  }, EXECUTION_TIMEOUT_MS);
}

// Captura de sinais do sistema operacional
process.on('SIGINT', () => realizarGracefulShutdown('SIGINT recebido'));
process.on('SIGTERM', () => realizarGracefulShutdown('SIGTERM recebido'));

main().catch((err) => {
  console.error('[FATAL] Erro não tratado na execução:', err);
  process.exit(1);
});
