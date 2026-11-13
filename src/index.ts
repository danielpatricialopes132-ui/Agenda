import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

import { config } from './config/env';
import { useSupabaseAuthState } from './services/supabaseAuthState';
import { extrairAgendamentoComIA } from './services/aiService';
import {
  mensagemJaProcessada,
  marcarMensagemProcessada,
  salvarAgendamento,
} from './services/supabaseService';
import { processarDisparosProgramados } from './services/cronService';

// Tempo total de execução antes do graceful shutdown (60 segundos)
const EXECUTION_TIMEOUT_MS = 60 * 1000;

async function runServerlessBot() {
  console.log('🤖 [GitHub Actions / Serverless] Iniciando ciclo do assistente de obra...');

  // 1. Carrega o estado de autenticação persistido no Supabase
  const { state, saveCreds } = await useSupabaseAuthState();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Se for primeira execução para login
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  // Salva credenciais automaticamente no Supabase
  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  // Fila de mensagens recebidas para processar de forma sequencial
  const processarMensagem = async (msg: proto.IWebMessageInfo) => {
    if (msg.key.fromMe) return;

    const messageId = msg.key.id;
    const remoteJid = msg.key.remoteJid;
    if (!messageId || !remoteJid) return;

    // Filtra exclusivamente o grupo configurado
    if (config.obraGroupId && remoteJid !== config.obraGroupId) {
      return;
    }

    // Deduplicação: verifica se já foi processada no Supabase
    const jaLida = await mensagemJaProcessada(messageId);
    if (jaLida) {
      return;
    }

    // Extrai texto da mensagem
    const texto =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption;

    if (!texto || texto.trim().length === 0) {
      // Marca como lida para não processar novamente em execuções futuras
      await marcarMensagemProcessada(messageId, remoteJid);
      return;
    }

    console.log(`[Nova Mensagem - Grupo Obra]: "${texto}"`);

    // Processamento NLP com Gemini
    const agendamento = await extrairAgendamentoComIA(texto);

    if (agendamento.is_agendamento) {
      console.log('🎯 Agendamento detectado pela IA:', agendamento);
      const salvo = await salvarAgendamento({
        obra_id: config.obraId,
        data_evento: agendamento.data_iso,
        horario: agendamento.horario,
        descricao: agendamento.descricao,
      });

      if (salvo) {
        try {
          // Reage com emoji de calendário
          await sock.sendMessage(remoteJid, {
            react: { text: '📅', key: msg.key },
          });
          console.log('✨ Reação de calendário 📅 enviada!');
        } catch (err) {
          console.error('Erro ao enviar reação no WhatsApp:', err);
        }
      }
    }

    // Registra a mensagem como processada
    await marcarMensagemProcessada(messageId, remoteJid);
  };

  // Evento de sincronização de histórico
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[Histórico] Sincronização recebida: ${messages.length} mensagens.`);
    for (const msg of messages) {
      await processarMensagem(msg);
    }
  });

  // Evento de mensagens recebidas / não lidas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      await processarMensagem(msg);
    }
  });

  // Aguarda conexão abrir
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ Conexão com WhatsApp ativa!');
      // Executa checagem de disparos programados
      await processarDisparosProgramados(sock);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[Conexão Fechada] Código: ${statusCode}`);
    }
  });

  // ========================================================
  // Graceful Shutdown após 60 segundos
  // ========================================================
  setTimeout(async () => {
    console.log(`\n⏳ Tempo de execução (${EXECUTION_TIMEOUT_MS / 1000}s) atingido. Iniciando Graceful Shutdown...`);
    try {
      // Garante persistência final das credenciais
      await saveCreds();
      sock.end(undefined);
      console.log('🔒 Socket Baileys finalizado com sucesso.');
    } catch (e) {
      console.error('Erro ao encerrar socket:', e);
    } finally {
      console.log('👋 Encerrando processo. Até a próxima execução!');
      process.exit(0);
    }
  }, EXECUTION_TIMEOUT_MS);
}

runServerlessBot().catch((err) => {
  console.error('Erro fatal no ciclo serverless:', err);
  process.exit(1);
});
