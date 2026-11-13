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

const EXECUTION_TIMEOUT_MS = 60 * 1000; // Janela efêmera de 60 segundos
let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;
let shutdownTriggered = false;

// ==============================================================================
// Cache em Memória de Obras Monitorizadas (Multi-Obras)
// ==============================================================================
interface ObraConfig {
  obra_id: string;
  nome_obra: string;
  responsaveis: string[];
  ativa: boolean;
}

let obrasCache: Map<string, ObraConfig> = new Map();
let ultimaAtualizacaoObras = 0;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos

/**
 * Atualiza o cache local de obras ativas consultando o Supabase.
 */
async function carregarObrasMonitoradas(forcar = false): Promise<Map<string, ObraConfig>> {
  const agora = Date.now();
  if (!forcar && obrasCache.size > 0 && agora - ultimaAtualizacaoObras < CACHE_TTL_MS) {
    return obrasCache;
  }

  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .eq('ativa', true);

    if (error) {
      console.warn('[DB Multi-Obras] Aviso ao consultar obras_config:', error.message);
      return obrasCache;
    }

    const novoMapa = new Map<string, ObraConfig>();
    for (const item of data || []) {
      novoMapa.set(item.obra_id, {
        obra_id: item.obra_id,
        nome_obra: item.nome_obra,
        responsaveis: Array.isArray(item.responsaveis) ? item.responsaveis : [],
        ativa: Boolean(item.ativa),
      });
    }

    obrasCache = novoMapa;
    ultimaAtualizacaoObras = agora;
    console.log(`[DB Multi-Obras] Cache de obras ativas atualizado: ${obrasCache.size} obras monitoradas.`);
  } catch (err) {
    console.error('[DB Multi-Obras] Exceção ao atualizar cache de obras:', err);
  }

  return obrasCache;
}

// ==============================================================================
// Operações no Banco de Dados (Supabase)
// ==============================================================================

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

async function registrarMensagemProcessada(messageId: string, remoteJid: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('mensagens_processadas')
      .insert([{ message_id: messageId, remote_jid: remoteJid }]);

    if (error && error.code !== '23505') {
      console.error(`[DB] Falha ao registrar mensagem processada "${messageId}":`, error.message);
    }
  } catch (err) {
    console.error(`[DB] Exceção ao registrar mensagem_processada "${messageId}":`, err);
  }
}

async function salvarAgendamento(
  obraId: string,
  dataEvento: string,
  horario: string | null,
  descricao: string
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('agenda_obra')
      .insert([
        {
          obra_id: obraId,
          data_evento: dataEvento,
          horario: horario || '08:00',
          descricao: descricao,
        },
      ]);

    if (error) {
      console.error('[DB] Erro ao salvar agendamento:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[DB] Exceção ao salvar na agenda_obra:', err);
    return false;
  }
}

async function relatorioJaEnviado(obraId: string, tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('disparos_executados')
      .select('id')
      .eq('obra_id', obraId)
      .eq('tipo_disparo', tipo)
      .eq('referencia_data', dataRef)
      .maybeSingle();

    if (error) {
      return false;
    }
    return !!data;
  } catch {
    return false;
  }
}

async function marcarRelatorioEnviado(obraId: string, tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('disparos_executados')
      .insert([{ obra_id: obraId, tipo_disparo: tipo, referencia_data: dataRef }]);

    if (error && error.code !== '23505') {
      console.warn(`[DB] Aviso ao registrar disparo ${tipo} para ${obraId}:`, error.message);
    }
  } catch (err) {
    console.warn(`[DB] Exceção ao registrar disparo executado:`, err);
  }
}

// ==============================================================================
// Motor de Disparos de Relatórios Multi-Obras (Grupo + Telefones dos Responsáveis)
// ==============================================================================

async function processarRelatoriosMultiObras(client: WASocket): Promise<void> {
  const obras = await carregarObrasMonitoradas();
  if (obras.size === 0) {
    console.log('[Relatórios Multi-Obras] Nenhuma obra ativa cadastrada. Disparos ignorados.');
    return;
  }

  const agora = new Date();
  const diaSemana = agora.getDay(); // 0: Dom, 1: Seg, 2: Ter, ..., 5: Sex, 6: Sáb
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Relatórios Multi-Obras] Analisando ${obras.size} obras. Dia=${diaSemana}, Hora=${hora}h, Data=${hojeIso}`);

  for (const [obraId, configObra] of obras.entries()) {
    // 1. Segunda-feira pela manhã (entre 07:00 e 11:59): Relatório Semanal
    if (diaSemana === 1 && hora >= 7 && hora <= 11) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'SEMANAL', hojeIso);
      if (!jaEnviado) {
        console.log(`📋 [Relatório Semanal] Compilando para "${configObra.nome_obra}"...`);
        const em5Dias = new Date();
        em5Dias.setDate(agora.getDate() + 5);
        const dataFimIso = em5Dias.toISOString().split('T')[0];

        const { data: eventos, error } = await supabase
          .from('agenda_obra')
          .select('*')
          .eq('obra_id', obraId)
          .gte('data_evento', hojeIso)
          .lte('data_evento', dataFimIso)
          .order('data_evento', { ascending: true })
          .order('horario', { ascending: true });

        if (!error) {
          let mensagem = `📋 *AGENDA DA SEMANA - ${configObra.nome_obra.toUpperCase()}*\n_Previsão dos próximos 5 dias de obra:_\n\n`;
          if (!eventos || eventos.length === 0) {
            mensagem += 'Nenhum agendamento cadastrado para os próximos dias.\nTenham todos uma excelente semana de trabalho!';
          } else {
            eventos.forEach((ev) => {
              const [ano, mes, dia] = ev.data_evento.split('-');
              mensagem += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
            });
            mensagem += 'Qualquer alteração ou novo fornecedor, favor avisar neste grupo.';
          }

          // Dispara no grupo principal da obra
          await client.sendMessage(obraId, { text: mensagem });

          // Dispara individualmente para cada responsável configurado
          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              const jidPrivado = `${numeroLimpo}@s.whatsapp.net`;
              try {
                await client.sendMessage(jidPrivado, { text: mensagem });
                console.log(`📨 Relatório semanal enviado no privado para ${numeroLimpo}`);
              } catch (privErr) {
                console.error(`Falha ao enviar relatório semanal para ${numeroLimpo}:`, privErr);
              }
            }
          }

          await marcarRelatorioEnviado(obraId, 'SEMANAL', hojeIso);
          console.log(`✅ Relatório semanal disparado para a obra "${configObra.nome_obra}".`);
        }
      }
    }

    // 2. Terça a Sexta pela manhã (entre 06:00 e 09:59): Relatório Diário
    if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'DIARIO', hojeIso);
      if (!jaEnviado) {
        console.log(`🌅 [Relatório Diário] Compilando para "${configObra.nome_obra}"...`);
        const { data: eventos, error } = await supabase
          .from('agenda_obra')
          .select('*')
          .eq('obra_id', obraId)
          .eq('data_evento', hojeIso)
          .order('horario', { ascending: true });

        if (!error) {
          let mensagem = `🌅 *LEMBRETES DO DIA - ${configObra.nome_obra.toUpperCase()}*\n_Atividades e entregas programadas para hoje:_\n\n`;
          if (!eventos || eventos.length === 0) {
            mensagem += 'Nenhum compromisso ou entrega de material prevista para hoje. Bom expediente!';
          } else {
            eventos.forEach((ev) => {
              mensagem += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
            });
            mensagem += '\nFiquem atentos aos recebimentos e frentes de serviço!';
          }

          // Dispara no grupo principal da obra
          await client.sendMessage(obraId, { text: mensagem });

          // Dispara individualmente para cada responsável configurado
          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              const jidPrivado = `${numeroLimpo}@s.whatsapp.net`;
              try {
                await client.sendMessage(jidPrivado, { text: mensagem });
                console.log(`📨 Lembrete diário enviado no privado para ${numeroLimpo}`);
              } catch (privErr) {
                console.error(`Falha ao enviar lembrete diário para ${numeroLimpo}:`, privErr);
              }
            }
          }

          await marcarRelatorioEnviado(obraId, 'DIARIO', hojeIso);
          console.log(`✅ Relatório diário disparado para a obra "${configObra.nome_obra}".`);
        }
      }
    }
  }
}

// ==============================================================================
// Processamento Dinâmico de Mensagens (Filtro por obras_config)
// ==============================================================================

async function processarMensagemIndividual(msg: proto.IWebMessageInfo, client: WASocket): Promise<void> {
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!remoteJid || !messageId) return;

  // Filtro Dinâmico: Verifica se o remoteJid pertence a uma obra cadastrada e ativa
  const obras = await carregarObrasMonitoradas();
  const configObra = obras.get(remoteJid);

  if (!configObra) {
    // Não é um grupo monitorado pelo GADAP Hub; ignora silenciosamente
    return;
  }

  // Deduplicação: verifica se a mensagem já foi lida
  const processada = await jaProcessouMensagem(messageId);
  if (processada) {
    return;
  }

  // Extrai texto da mensagem
  const texto =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption;

  if (!texto || texto.trim().length === 0) {
    await registrarMensagemProcessada(messageId, remoteJid);
    return;
  }

  console.log(`[WhatsApp - Obra "${configObra.nome_obra}"]: "${texto}"`);

  // Extração via Gemini com a data de hoje como base
  const hojeIso = new Date().toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log(`🎯 [AI - ${configObra.nome_obra}] Agendamento detectado:`, resultado);
    const salvo = await salvarAgendamento(remoteJid, resultado.data_iso, resultado.horario, resultado.descricao);

    if (salvo) {
      try {
        await client.sendMessage(remoteJid, {
          react: { text: '📅', key: msg.key },
        });
        console.log(`✨ Reação 📅 enviada no grupo "${configObra.nome_obra}"!`);
      } catch (err) {
        console.error('Erro ao enviar reação no WhatsApp:', err);
      }
    }
  }

  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// Ciclo Efêmero e Graceful Shutdown
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
      console.log('[WhatsApp] Conexão finalizada com sucesso.');
    }
  } catch (err) {
    console.error('[Shutdown] Erro ao consolidar sessão durante shutdown:', err);
  } finally {
    console.log('👋 [GADAP Hub] Ciclo efêmero finalizado. Encerrando processo...');
    process.exit(0);
  }
}

async function main() {
  console.log('🚀 [GADAP Hub Bot] Inicializando runner efêmero Multi-Obras...');

  // Inicializa a lista de obras monitoradas
  await carregarObrasMonitoradas(true);

  const { state, saveCreds } = await useSupabaseAuthState('obra_principal');
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

    if (qr) {
      console.log('\n======================================================');
      console.log('⚡ SESSÃO NÃO ENCONTRADA. ESCANEIE O QR CODE ABAIXO:');
      qrcode.generate(qr, { small: true });
      console.log('======================================================\n');
    }

    if (connection === 'open') {
      console.log('✅ [WhatsApp] Conectado e autenticado com sucesso!');
      if (sock) {
        await processarRelatoriosMultiObras(sock);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[WhatsApp] Conexão encerrada (statusCode: ${statusCode}).`);
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Dispositivo deslogado. Novo QR Code necessário.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[WhatsApp] Histórico de mensagens recebido (${messages.length} msgs). Sincronizando...`);
    for (const msg of messages) {
      if (sock) {
        await processarMensagemIndividual(msg, sock);
      }
    }
  });

  setTimeout(() => {
    realizarGracefulShutdown(`Timeout de ${EXECUTION_TIMEOUT_MS / 1000}s atingido`);
  }, EXECUTION_TIMEOUT_MS);
}

process.on('SIGINT', () => realizarGracefulShutdown('SIGINT recebido'));
process.on('SIGTERM', () => realizarGracefulShutdown('SIGTERM recebido'));

main().catch((err) => {
  console.error('[FATAL] Erro não tratado na execução:', err);
  process.exit(1);
});
