import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import dotenv from 'dotenv';

import { useSupabaseAuthState, supabase } from './lib/useSupabaseAuthState';
import { extrairAgendamento, detectarConflitosAgenda } from './lib/aiProcessor';
import { gerarImagemAgendaSemana, EventoRelatorio } from './lib/reportGenerator';
import { gerarAudioBriefing } from './lib/audioBriefing';

dotenv.config();

// Janela máxima de vida do runner efêmero: 75 segundos (entre 60s e 90s)
const EXECUTION_TIMEOUT_MS = 75 * 1000;

let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;
let shutdownTriggered = false;

// ==============================================================================
// Cache de Obras Monitorizadas
// ==============================================================================
interface ObraConfig {
  obra_id: string;
  nome_obra: string;
  responsaveis: string[];
  ativa: boolean;
}

let obrasCache: Map<string, ObraConfig> = new Map();

async function carregarObrasAtivas(): Promise<Map<string, ObraConfig>> {
  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .eq('ativa', true);

    if (error) {
      console.warn('[Bot Efêmero] Aviso ao consultar obras_config:', error.message);
      return obrasCache;
    }

    const mapa = new Map<string, ObraConfig>();
    for (const item of data || []) {
      mapa.set(item.obra_id, {
        obra_id: item.obra_id,
        nome_obra: item.nome_obra,
        responsaveis: Array.isArray(item.responsaveis) ? item.responsaveis : [],
        ativa: Boolean(item.ativa),
      });
    }

    obrasCache = mapa;
    console.log(`[Bot Efêmero] ${obrasCache.size} obras ativas carregadas do Supabase.`);
  } catch (err) {
    console.error('[Bot Efêmero] Exceção ao carregar obras:', err);
  }

  return obrasCache;
}

// ==============================================================================
// Consultas no Banco de Dados (Supabase)
// ==============================================================================

async function jaProcessouMensagem(messageId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('mensagens_processadas')
      .select('message_id')
      .eq('message_id', messageId)
      .maybeSingle();

    return !!data;
  } catch {
    return false;
  }
}

async function registrarMensagemProcessada(messageId: string, remoteJid: string): Promise<void> {
  try {
    await supabase.from('mensagens_processadas').insert([{ message_id: messageId, remote_jid: remoteJid }]);
  } catch {}
}

async function buscarEventosDoDia(obraId: string, dataIso: string): Promise<EventoRelatorio[]> {
  try {
    const { data } = await supabase
      .from('agenda_obra')
      .select('data_evento, horario, descricao')
      .eq('obra_id', obraId)
      .eq('data_evento', dataIso)
      .order('horario', { ascending: true });

    return (data || []) as EventoRelatorio[];
  } catch {
    return [];
  }
}

async function buscarEventosPorIntervalo(obraId: string, dataInicio: string, dataFim: string): Promise<EventoRelatorio[]> {
  try {
    const { data } = await supabase
      .from('agenda_obra')
      .select('data_evento, horario, descricao')
      .eq('obra_id', obraId)
      .gte('data_evento', dataInicio)
      .lte('data_evento', dataFim)
      .order('data_evento', { ascending: true })
      .order('horario', { ascending: true });

    return (data || []) as EventoRelatorio[];
  } catch {
    return [];
  }
}

async function salvarAgendamento(
  obraId: string,
  dataEvento: string,
  horario: string | null,
  descricao: string
): Promise<boolean> {
  try {
    const { error } = await supabase.from('agenda_obra').insert([
      {
        obra_id: obraId,
        data_evento: dataEvento,
        horario: horario || '08:00',
        descricao: descricao,
      },
    ]);
    return !error;
  } catch {
    return false;
  }
}

async function relatorioJaEnviado(obraId: string, tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('disparos_executados')
      .select('id')
      .eq('obra_id', obraId)
      .eq('tipo_disparo', tipo)
      .eq('referencia_data', dataRef)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

async function marcarRelatorioEnviado(obraId: string, tipo: 'SEMANAL' | 'DIARIO', dataRef: string): Promise<void> {
  try {
    await supabase
      .from('disparos_executados')
      .insert([{ obra_id: obraId, tipo_disparo: tipo, referencia_data: dataRef }]);
  } catch {}
}

// ==============================================================================
// Processamento de Mensagens com IA
// ==============================================================================

async function processarMensagemIndividual(msg: proto.IWebMessageInfo, client: WASocket): Promise<void> {
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!remoteJid || !messageId) return;

  // Filtra mensagens cujos remetentes (remoteJid) existam na tabela obras_config
  const configObra = obrasCache.get(remoteJid);
  if (!configObra) return;

  // Ignora mensagens já presentes na tabela mensagens_processadas
  const processada = await jaProcessouMensagem(messageId);
  if (processada) return;

  const texto =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption;

  if (!texto || texto.trim().length === 0) {
    await registrarMensagemProcessada(messageId, remoteJid);
    return;
  }

  console.log(`[Bot Efêmero - ${configObra.nome_obra}]: "${texto}"`);

  // Extração via IA (Gemini)
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log(`🎯 [AI - ${configObra.nome_obra}] Agendamento detectado:`, resultado);

    // Detector de Conflitos
    const eventosExistentes = await buscarEventosDoDia(remoteJid, resultado.data_iso);
    const analiseConflito = await detectarConflitosAgenda(
      { descricao: resultado.descricao, horario: resultado.horario },
      eventosExistentes
    );

    const salvo = await salvarAgendamento(remoteJid, resultado.data_iso, resultado.horario, resultado.descricao);

    if (salvo) {
      try {
        await client.sendMessage(remoteJid, {
          react: { text: analiseConflito.tem_conflito ? '⚠️' : '📅', key: msg.key },
        });

        const [ano, mes, dia] = resultado.data_iso.split('-');
        const horarioFmt = resultado.horario || 'Horário comercial (08:00)';

        let mensagemConfirmacao = `✅ *AGENDAMENTO REGISTRADO - ${configObra.nome_obra.toUpperCase()}*\n\n` +
          `🗓️ *Data:* ${dia}/${mes}/${ano}\n` +
          `⏰ *Horário:* ${horarioFmt}\n` +
          `📌 *Compromisso:* ${resultado.descricao}\n`;

        if (analiseConflito.tem_conflito && analiseConflito.motivo_conflito) {
          mensagemConfirmacao += `\n⚠️ *ALERTA DE CONFLITO LOGÍSTICO:*\n${analiseConflito.motivo_conflito}\n` +
            (analiseConflito.sugestao ? `💡 *Sugestão:* ${analiseConflito.sugestao}\n` : '');
        }

        await client.sendMessage(
          remoteJid,
          { text: mensagemConfirmacao },
          { quoted: { key: msg.key, message: { conversation: texto } } }
        );
      } catch (err) {
        console.error('[Bot Efêmero] Erro ao responder agendamento:', err);
      }
    }
  }

  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// Rotina de Disparos de Relatórios e Morning Briefing em Áudio
// ==============================================================================

async function processarRelatoriosPendentes(client: WASocket): Promise<void> {
  if (obrasCache.size === 0) return;

  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  for (const [obraId, configObra] of obrasCache.entries()) {
    // 1. Segunda-feira pela manhã (entre 07:00 e 11:59): Infográfico Semanal
    if (diaSemana === 1 && hora >= 7 && hora <= 11) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'SEMANAL', hojeIso);
      if (!jaEnviado) {
        const em5Dias = new Date();
        em5Dias.setDate(agora.getDate() + 5);
        const dataFimIso = em5Dias.toISOString().split('T')[0];

        const eventos = await buscarEventosPorIntervalo(obraId, hojeIso, dataFimIso);

        try {
          const imagemBuffer = await gerarImagemAgendaSemana(configObra.nome_obra, eventos, 'SEMANAL');
          const caption = `📋 *Resumo da Semana - ${configObra.nome_obra}*\nResumo da agenda atualizado. Bom trabalho à equipe!`;

          await client.sendMessage(obraId, { image: imagemBuffer, caption });

          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              try {
                await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { image: imagemBuffer, caption });
              } catch {}
            }
          }

          await marcarRelatorioEnviado(obraId, 'SEMANAL', hojeIso);
          console.log(`✅ Infográfico semanal enviado para "${configObra.nome_obra}".`);
        } catch (imgErr) {
          console.error('[Bot Efêmero] Erro ao enviar infográfico semanal:', imgErr);
        }
      }
    }

    // 2. Terça a Sexta pela manhã (entre 06:00 e 09:59): Lembretes do Dia + Áudio TTS
    if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'DIARIO', hojeIso);
      if (!jaEnviado) {
        const eventos = await buscarEventosDoDia(obraId, hojeIso);

        try {
          // Imagem
          const imagemBuffer = await gerarImagemAgendaSemana(configObra.nome_obra, eventos, 'DIARIO');
          const caption = `🌅 *Lembretes do Dia - ${configObra.nome_obra}*\nResumo da agenda atualizado. Bom trabalho à equipe!`;
          await client.sendMessage(obraId, { image: imagemBuffer, caption });

          // Áudio TTS (Push-to-Talk)
          try {
            const audioBuffer = await gerarAudioBriefing(eventos, configObra.nome_obra);
            await client.sendMessage(obraId, {
              audio: audioBuffer,
              mimetype: 'audio/mp4',
              ptt: true,
            });
            console.log(`🎙️ Briefing em áudio enviado para "${configObra.nome_obra}".`);
          } catch (audioErr) {
            console.warn('[Bot Efêmero] Erro ao enviar áudio TTS:', audioErr);
          }

          // Responsáveis
          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              try {
                await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { image: imagemBuffer, caption });
              } catch {}
            }
          }

          await marcarRelatorioEnviado(obraId, 'DIARIO', hojeIso);
          console.log(`✅ Lembretes diários enviados para "${configObra.nome_obra}".`);
        } catch (imgErr) {
          console.error('[Bot Efêmero] Erro ao enviar lembretes diários:', imgErr);
        }
      }
    }
  }
}

// ==============================================================================
// Graceful Shutdown Efêmero Controlado (60-90s)
// ==============================================================================

async function realizarGracefulShutdown(motivo: string) {
  if (shutdownTriggered) return;
  shutdownTriggered = true;

  console.log(`\n⏳ [Bot Efêmero] Iniciando encerramento gracioso (${motivo})...`);
  try {
    if (saveCredsFn) {
      await saveCredsFn();
      console.log('[Bot Efêmero] Credenciais do Baileys salvas no Supabase.');
    }
    if (sock) {
      sock.end(undefined);
      console.log('[Bot Efêmero] Socket finalizado.');
    }
  } catch (err) {
    console.error('[Bot Efêmero] Erro no shutdown:', err);
  } finally {
    console.log('🏁 [Bot Efêmero] Execução finalizada com sucesso. Chamando process.exit(0)...');
    process.exit(0);
  }
}

// ==============================================================================
// Execução Principal do Bot
// ==============================================================================

async function main() {
  console.log('🚀 [GADAP Hub] Inicializando Trabalhador Efêmero (GitHub Actions)...');

  // Carrega lista de obras monitoradas
  await carregarObrasAtivas();

  // Puxa o auth state remoto do Supabase
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
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ [Bot Efêmero] WhatsApp conectado com sucesso via Supabase Session!');
      if (sock) {
        await processarRelatoriosPendentes(sock);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[Bot Efêmero] Conexão encerrada com statusCode: ${statusCode}`);
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[Bot Efêmero] Dispositivo desconectado (loggedOut). Refaça o login via setup local.');
      }
    }
  });

  // Mensagens novas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });

  // Sincronização de histórico
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[Bot Efêmero] Histórico recebido (${messages.length} msgs). Processando mensagens não lidas...`);
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });

  // Timer do encerramento gracioso (75s)
  setTimeout(() => {
    realizarGracefulShutdown(`Timeout de ${EXECUTION_TIMEOUT_MS / 1000}s atingido`);
  }, EXECUTION_TIMEOUT_MS);
}

process.on('SIGINT', () => realizarGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => realizarGracefulShutdown('SIGTERM'));

main().catch((err) => {
  console.error('[FATAL]:', err);
  process.exit(1);
});

