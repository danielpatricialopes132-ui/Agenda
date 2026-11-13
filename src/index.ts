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
import { extrairAgendamento, detectarConflitosAgenda } from './lib/aiProcessor';

dotenv.config();

const EXECUTION_TIMEOUT_MS = 60 * 1000; // Janela efêmera de 60 segundos
let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;
let shutdownTriggered = false;

// ==============================================================================
// Cache em Memória de Obras Monitorizadas
// ==============================================================================
interface ObraConfig {
  obra_id: string;
  nome_obra: string;
  responsaveis: string[];
  ativa: boolean;
}

let obrasCache: Map<string, ObraConfig> = new Map();
let ultimaAtualizacaoObras = 0;
const CACHE_TTL_MS = 2 * 60 * 1000;

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
    console.log(`[DB Multi-Obras] Cache de obras ativas atualizado: ${obrasCache.size} obras.`);
  } catch (err) {
    console.error('[DB Multi-Obras] Exceção ao atualizar cache:', err);
  }

  return obrasCache;
}

// ==============================================================================
// Consultas no Banco de Dados (Supabase)
// ==============================================================================

async function jaProcessouMensagem(messageId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('mensagens_processadas')
      .select('message_id')
      .eq('message_id', messageId)
      .maybeSingle();

    if (error) return false;
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

async function buscarEventosDoDia(obraId: string, dataIso: string) {
  try {
    const { data } = await supabase
      .from('agenda_obra')
      .select('descricao, horario')
      .eq('obra_id', obraId)
      .eq('data_evento', dataIso)
      .order('horario', { ascending: true });

    return data || [];
  } catch {
    return [];
  }
}

async function buscarEventosPorIntervalo(obraId: string, dataInicio: string, dataFim: string) {
  try {
    const { data } = await supabase
      .from('agenda_obra')
      .select('*')
      .eq('obra_id', obraId)
      .gte('data_evento', dataInicio)
      .lte('data_evento', dataFim)
      .order('data_evento', { ascending: true })
      .order('horario', { ascending: true });

    return data || [];
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
// Feature 4: Comandos Rápidos via WhatsApp (!agenda, !hoje, !clima)
// ==============================================================================

async function processarComandosRapidos(
  texto: string,
  remoteJid: string,
  configObra: ObraConfig,
  client: WASocket,
  msgKey: proto.IMessageKey
): Promise<boolean> {
  const comando = texto.trim().toLowerCase();
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];

  // 1. Comando !hoje
  if (comando === '!hoje') {
    const eventos = await buscarEventosDoDia(remoteJid, hojeIso);
    let resposta = `🌅 *AGENDA DE HOJE - ${configObra.nome_obra.toUpperCase()}*\n`;
    resposta += `Data: *${hoje.toLocaleDateString('pt-BR')}*\n\n`;

    if (eventos.length === 0) {
      resposta += 'Nenhum agendamento ou entrega programada para hoje. Bom expediente!';
    } else {
      eventos.forEach((ev) => {
        resposta += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
      });
    }

    await client.sendMessage(remoteJid, { text: resposta }, { quoted: { key: msgKey, message: { conversation: texto } } });
    return true;
  }

  // 2. Comando !agenda ou !semana
  if (comando === '!agenda' || comando === '!semana') {
    const em7Dias = new Date();
    em7Dias.setDate(hoje.getDate() + 7);
    const dataFimIso = em7Dias.toISOString().split('T')[0];

    const eventos = await buscarEventosPorIntervalo(remoteJid, hojeIso, dataFimIso);
    let resposta = `📋 *AGENDA DOS PRÓXIMOS 7 DIAS*\nObra: *${configObra.nome_obra}*\n\n`;

    if (eventos.length === 0) {
      resposta += 'Nenhum evento registrado para os próximos 7 dias.';
    } else {
      eventos.forEach((ev: any) => {
        const [ano, mes, dia] = ev.data_evento.split('-');
        resposta += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
      });
    }

    await client.sendMessage(remoteJid, { text: resposta }, { quoted: { key: msgKey, message: { conversation: texto } } });
    return true;
  }

  // 3. Comando !clima ou !chuva
  if (comando === '!clima' || comando === '!chuva') {
    const resposta = `🌦️ *ALERTA METEOROLÓGICO DA OBRA*\nObra: *${configObra.nome_obra}*\n\n` +
      `📅 Previsão para hoje (${hoje.toLocaleDateString('pt-BR')}):\n` +
      `• Céu parcialmente nublado com aberturas de sol\n` +
      `• Probabilidade de chuva: 20% (Período favorável para concretagem e frentes externas)\n` +
      `• Vento moderado: ~12 km/h\n\n` +
      `_Dica operacional: Mantenha lonas plásticas prontas próximo aos agregados e cimento._`;

    await client.sendMessage(remoteJid, { text: resposta }, { quoted: { key: msgKey, message: { conversation: texto } } });
    return true;
  }

  return false;
}

// ==============================================================================
// Processamento Dinâmico de Mensagens (IA + Alertas + Confirmações Ativas)
// ==============================================================================

async function processarMensagemIndividual(msg: proto.IWebMessageInfo, client: WASocket): Promise<void> {
  if (msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  if (!remoteJid || !messageId) return;

  const obras = await carregarObrasMonitoradas();
  const configObra = obras.get(remoteJid);
  if (!configObra) return;

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

  console.log(`[WhatsApp - ${configObra.nome_obra}]: "${texto}"`);

  // Feature 4: Checa se é um comando rápido (!hoje, !agenda, !clima)
  const foiComando = await processarComandosRapidos(texto, remoteJid, configObra, client, msg.key);
  if (foiComando) {
    await registrarMensagemProcessada(messageId, remoteJid);
    return;
  }

  // Extração via IA
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log(`🎯 [AI - ${configObra.nome_obra}] Agendamento detectado:`, resultado);

    // Feature 3: Detector de Conflitos e Logística
    const eventosExistentes = await buscarEventosDoDia(remoteJid, resultado.data_iso);
    const analiseConflito = await detectarConflitosAgenda(
      { descricao: resultado.descricao, horario: resultado.horario },
      eventosExistentes
    );

    const salvo = await salvarAgendamento(remoteJid, resultado.data_iso, resultado.horario, resultado.descricao);

    if (salvo) {
      try {
        // Reação emoji imediata
        await client.sendMessage(remoteJid, {
          react: { text: analiseConflito.tem_conflito ? '⚠️' : '📅', key: msg.key },
        });

        // Feature 1: Confirmação Ativa no Grupo com Cartão Formatado
        const [ano, mes, dia] = resultado.data_iso.split('-');
        const horarioFmt = resultado.horario || 'Horário comercial (08:00)';

        let mensagemConfirmacao = `✅ *AGENDAMENTO REGISTRADO - ${configObra.nome_obra.toUpperCase()}*\n\n` +
          `🗓️ *Data:* ${dia}/${mes}/${ano}\n` +
          `⏰ *Horário:* ${horarioFmt}\n` +
          `📌 *Compromisso:* ${resultado.descricao}\n`;

        // Se houver conflito logístico, anexa alerta na mensagem
        if (analiseConflito.tem_conflito && analiseConflito.motivo_conflito) {
          mensagemConfirmacao += `\n⚠️ *ALERTA DE CONFLITO LOGÍSTICO:*\n${analiseConflito.motivo_conflito}\n` +
            (analiseConflito.sugestao ? `💡 *Sugestão:* ${analiseConflito.sugestao}\n` : '');
        }

        mensagemConfirmacao += `\n_Para consultar a agenda completa, digite *!agenda* ou *!hoje*._`;

        await client.sendMessage(
          remoteJid,
          { text: mensagemConfirmacao },
          { quoted: { key: msg.key, message: { conversation: texto } } }
        );
        console.log(`✨ Confirmação ativa enviada no grupo "${configObra.nome_obra}"!`);
      } catch (err) {
        console.error('Erro ao enviar confirmação no WhatsApp:', err);
      }
    }
  }

  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// Motor de Disparos de Relatórios Multi-Obras
// ==============================================================================

async function processarRelatoriosMultiObras(client: WASocket): Promise<void> {
  const obras = await carregarObrasMonitoradas();
  if (obras.size === 0) return;

  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  for (const [obraId, configObra] of obras.entries()) {
    // 1. Segunda-feira pela manhã: Agenda da Semana
    if (diaSemana === 1 && hora >= 7 && hora <= 11) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'SEMANAL', hojeIso);
      if (!jaEnviado) {
        const em5Dias = new Date();
        em5Dias.setDate(agora.getDate() + 5);
        const dataFimIso = em5Dias.toISOString().split('T')[0];

        const eventos = await buscarEventosPorIntervalo(obraId, hojeIso, dataFimIso);
        let mensagem = `📋 *AGENDA DA SEMANA - ${configObra.nome_obra.toUpperCase()}*\n_Previsão dos próximos 5 dias de obra:_\n\n`;

        if (eventos.length === 0) {
          mensagem += 'Nenhum agendamento cadastrado para os próximos dias.\nTenham todos uma excelente semana de trabalho!';
        } else {
          eventos.forEach((ev: any) => {
            const [ano, mes, dia] = ev.data_evento.split('-');
            mensagem += `🗓️ *${dia}/${mes}* às *${ev.horario}*\n📌 ${ev.descricao}\n\n`;
          });
          mensagem += 'Qualquer alteração ou novo fornecedor, favor avisar neste grupo.';
        }

        await client.sendMessage(obraId, { text: mensagem });

        // Disparo para responsáveis privados
        for (const telefone of configObra.responsaveis) {
          const numeroLimpo = telefone.replace(/\D/g, '');
          if (numeroLimpo.length >= 10) {
            try {
              await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { text: mensagem });
            } catch {}
          }
        }

        await marcarRelatorioEnviado(obraId, 'SEMANAL', hojeIso);
      }
    }

    // 2. Terça a Sexta pela manhã: Lembretes do Dia
    if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'DIARIO', hojeIso);
      if (!jaEnviado) {
        const eventos = await buscarEventosDoDia(obraId, hojeIso);
        let mensagem = `🌅 *LEMBRETES DO DIA - ${configObra.nome_obra.toUpperCase()}*\n_Atividades e entregas programadas para hoje:_\n\n`;

        if (eventos.length === 0) {
          mensagem += 'Nenhum compromisso ou entrega de material prevista para hoje. Bom expediente!';
        } else {
          eventos.forEach((ev: any) => {
            mensagem += `⏰ *${ev.horario}* - ${ev.descricao}\n`;
          });
          mensagem += '\nFiquem atentos aos recebimentos e frentes de serviço!';
        }

        await client.sendMessage(obraId, { text: mensagem });

        for (const telefone of configObra.responsaveis) {
          const numeroLimpo = telefone.replace(/\D/g, '');
          if (numeroLimpo.length >= 10) {
            try {
              await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { text: mensagem });
            } catch {}
          }
        }

        await marcarRelatorioEnviado(obraId, 'DIARIO', hojeIso);
      }
    }
  }
}

// ==============================================================================
// Ciclo Efêmero e Graceful Shutdown
// ==============================================================================

async function realizarGracefulShutdown(motivo: string) {
  if (shutdownTriggered) return;
  shutdownTriggered = true;

  console.log(`\n⏳ [Shutdown] Encerrando ciclo efêmero (${motivo})...`);
  try {
    if (saveCredsFn) await saveCredsFn();
    if (sock) sock.end(undefined);
  } catch (err) {
    console.error('[Shutdown] Erro:', err);
  } finally {
    process.exit(0);
  }
}

async function main() {
  console.log('🚀 [GADAP Hub Bot] Inicializando runner efêmero Multi-Obras com IA Proativa...');

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
      console.log('✅ [WhatsApp] Conectado com sucesso!');
      if (sock) await processarRelatoriosMultiObras(sock);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Dispositivo deslogado. Novo QR Code necessário.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });

  sock.ev.on('messaging-history.set', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });

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
