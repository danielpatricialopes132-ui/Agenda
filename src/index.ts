import express, { Request, Response } from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import { config } from './config/env';
import { extrairAgendamentoComIA } from './services/aiService';
import { salvarAgendamento } from './services/supabaseService';
import { inicializarCron } from './services/cronService';

// Referência global da conexão do WhatsApp
let sock: WASocket | null = null;

// ==========================================
// 1. Servidor Express para Health Check (Render)
// ==========================================
const app = express();
app.use(express.json());

app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'online',
    message: 'Bot de Gestão de Obra ativo e operante!',
    timestamp: new Date().toISOString(),
  });
});

app.listen(config.port, () => {
  console.log(`🚀 Servidor Express rodando na porta ${config.port} (Health check pronto para o Render)`);
});

// ==========================================
// 2. Conexão Baileys (WhatsApp)
// ==========================================
async function conectarWhatsApp() {
  // Mantém estado de autenticação em disco (pasta auth_info_baileys)
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Gerenciamos o QR manualmente com qrcode-terminal
    logger: pino({ level: 'silent' }), // Silencia logs verbosos do Baileys
  });

  // Salva credenciais atualizadas
  sock.ev.on('creds.update', saveCreds);

  // Monitora status da conexão e reconexões
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Exibe QR Code no terminal quando disponível
    if (qr) {
      console.log('\n========================================');
      console.log('⚡ Escaneie o QR Code abaixo com seu WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('========================================\n');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const deveReconectar = statusCode !== DisconnectReason.loggedOut;

      console.warn(`[WhatsApp] Conexão encerrada. Motivo: ${statusCode}. Tentando reconectar: ${deveReconectar}`);

      if (deveReconectar) {
        setTimeout(() => {
          conectarWhatsApp();
        }, 3000);
      } else {
        console.error('[WhatsApp] Sessão encerrada (logout). Exclua a pasta auth_info_baileys e gere novo QR Code.');
      }
    } else if (connection === 'open') {
      console.log('✅ Conexão com WhatsApp estabelecida com sucesso!');
    }
  });

  // ==========================================
  // 3. Listener e Filtro de Mensagens
  // ==========================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignora mensagens enviadas pelo próprio bot
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Log para ajudar a identificar o ID do grupo caso ainda não configurado
      if (remoteJid.endsWith('@g.us') && (!config.obraGroupId || config.obraGroupId.includes('XXXXX'))) {
        console.log(`[DICA] Mensagem recebida de grupo: "${remoteJid}". Se for o grupo da obra, configure OBRA_GROUP_ID=${remoteJid} no .env`);
      }

      // Filtra estritamente pelo ID do grupo configurado (se definido)
      if (config.obraGroupId && remoteJid !== config.obraGroupId) {
        continue;
      }

      // Extrai texto da mensagem (suporta texto direto ou legenda de mídia)
      const textoMensagem =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption;

      if (!textoMensagem || textoMensagem.trim().length === 0) continue;

      console.log(`[Mensagem Recebida no Grupo da Obra]: "${textoMensagem}"`);

      // 4. Processamento NLP via IA (Gemini)
      const resultado = await extrairAgendamentoComIA(textoMensagem);

      if (resultado.is_agendamento) {
        console.log('🎯 Agendamento detectado pela IA:', resultado);

        // 5. Salvar no Supabase
        const salvo = await salvarAgendamento({
          obra_id: config.obraId,
          data_evento: resultado.data_iso,
          horario: resultado.horario,
          descricao: resultado.descricao,
        });

        // 6. Reagir à mensagem com emoji de calendário "📅"
        if (salvo && sock) {
          try {
            await sock.sendMessage(remoteJid, {
              react: {
                text: '📅',
                key: msg.key,
              },
            });
            console.log('✨ Reação de calendário 📅 enviada com sucesso!');
          } catch (reactErr) {
            console.error('Erro ao reagir à mensagem:', reactErr);
          }
        }
      }
    }
  });
}

// Inicia Baileys
conectarWhatsApp();

// Inicia rotinas do cron passando getter para obter o socket atualizado
inicializarCron(() => sock);

