import express, { Request, Response } from 'express';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';

import { useSupabaseAuthState, supabase } from './lib/useSupabaseAuthState';
import { extrairAgendamento, detectarConflitosAgenda } from './lib/aiProcessor';
import { gerarImagemAgendaSemana, EventoRelatorio } from './lib/reportGenerator';
import { gerarAudioBriefing } from './lib/audioBriefing';

dotenv.config();

// ==============================================================================
// 1. Estado Global da Aplicação
// ==============================================================================
type StatusConexao = 'desconectado' | 'qr' | 'conectado';

interface GrupoInfo {
  id: string;
  subject: string;
  participantsCount?: number;
}

export interface ObraConfig {
  obra_id: string;
  nome_obra: string;
  responsaveis: string[];
  ativa: boolean;
  created_at?: string;
}

let status: StatusConexao = 'desconectado';
let qrCodeImage: string | null = null;
let gruposLista: GrupoInfo[] = [];
let sock: WASocket | null = null;
let saveCredsFn: (() => Promise<void>) | null = null;

let obrasCache: Map<string, ObraConfig> = new Map();
let ultimaAtualizacaoObras = 0;
const CACHE_TTL_MS = 2 * 60 * 1000;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ==============================================================================
// 2. Cache e Operações no Supabase
// ==============================================================================
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
      console.warn('[DB] Aviso ao consultar obras_config:', error.message);
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
    console.log(`[DB] Cache de obras ativas sincronizado: ${obrasCache.size} obras.`);
  } catch (err) {
    console.error('[DB] Exceção ao atualizar cache de obras:', err);
  }

  return obrasCache;
}

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
// 3. Motor de Disparos de Relatórios (Multi-Obras)
// ==============================================================================
async function processarRelatoriosPendentes(client: WASocket): Promise<void> {
  const obras = await carregarObrasMonitoradas();
  if (obras.size === 0) return;

  const agora = new Date();
  const diaSemana = agora.getDay(); // 0: Dom, 1: Seg, 2: Ter, ..., 5: Sex, 6: Sáb
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Relatórios] Verificando regras de envio: Dia=${diaSemana}, Hora=${hora}h, Data=${hojeIso}`);

  for (const [obraId, configObra] of obras.entries()) {
    // 1. Segunda-feira pela manhã (entre 07:00 e 11:59): Infográfico Semanal em Imagem
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
          console.log(`✅ Infográfico semanal disparado para "${configObra.nome_obra}".`);
        } catch (imgErr) {
          console.error('[Relatórios] Falha ao enviar infográfico semanal:', imgErr);
        }
      }
    }

    // 2. Terça a Sexta pela manhã (entre 06:00 e 09:59): Lembretes do Dia em Imagem + Áudio TTS
    if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'DIARIO', hojeIso);
      if (!jaEnviado) {
        const eventos = await buscarEventosDoDia(obraId, hojeIso);

        try {
          // A) Disparo do Infográfico em Imagem
          const imagemBuffer = await gerarImagemAgendaSemana(configObra.nome_obra, eventos, 'DIARIO');
          const caption = `🌅 *Lembretes do Dia - ${configObra.nome_obra}*\nResumo da agenda atualizado. Bom trabalho à equipe!`;
          await client.sendMessage(obraId, { image: imagemBuffer, caption });

          // B) Disparo do Morning Briefing em Áudio (PTT)
          try {
            const audioBuffer = await gerarAudioBriefing(eventos, configObra.nome_obra);
            await client.sendMessage(obraId, {
              audio: audioBuffer,
              mimetype: 'audio/mp4',
              ptt: true,
            });
            console.log(`🎙️ Morning Briefing em áudio enviado para "${configObra.nome_obra}".`);
          } catch (audioErr) {
            console.warn('[Relatórios] Falha ao enviar áudio TTS:', audioErr);
          }

          // C) Envio para os responsáveis privados
          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              try {
                await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { image: imagemBuffer, caption });
              } catch {}
            }
          }

          await marcarRelatorioEnviado(obraId, 'DIARIO', hojeIso);
          console.log(`✅ Lembretes diários disparados para "${configObra.nome_obra}".`);
        } catch (imgErr) {
          console.error('[Relatórios] Falha ao enviar lembretes diários:', imgErr);
        }
      }
    }
  }
}

// ==============================================================================
// 4. Processamento Dinâmico de Mensagens com IA
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

  // Extração via IA (Gemini)
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log(`🎯 [AI - ${configObra.nome_obra}] Agendamento detectado:`, resultado);

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
        console.error('Erro ao responder agendamento no WhatsApp:', err);
      }
    }
  }

  await registrarMensagemProcessada(messageId, remoteJid);
}

// ==============================================================================
// 5. Conexão Baileys Unificada (com Reconexão Automática)
// ==============================================================================
async function iniciarBaileys() {
  console.log('[WhatsApp] Carregando sessão remota do Supabase...');
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
      status = 'qr';
      try {
        qrCodeImage = await QRCode.toDataURL(qr);
        console.log('[WhatsApp] Novo QR Code gerado.');
      } catch (err) {
        console.error('[WhatsApp] Falha ao converter QR Code:', err);
      }
    }

    if (connection === 'open') {
      status = 'conectado';
      qrCodeImage = null;
      console.log('✅ [WhatsApp] Conectado e autenticado com sucesso!');

      try {
        if (sock) {
          const grupos = await sock.groupFetchAllParticipating();
          gruposLista = Object.values(grupos).map((g) => ({
            id: g.id,
            subject: g.subject || 'Sem Nome',
            participantsCount: g.participants?.length || 0,
          }));
          console.log(`[WhatsApp] ${gruposLista.length} grupos identificados.`);

          // Processa relatórios pendentes ao conectar
          await processarRelatoriosPendentes(sock);
        }
      } catch (err) {
        console.error('[WhatsApp] Erro pós-conexão:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const deveReconectar = statusCode !== DisconnectReason.loggedOut;
      status = 'desconectado';
      console.warn(`[WhatsApp] Conexão encerrada (statusCode: ${statusCode}). Reconectando: ${deveReconectar}`);

      if (deveReconectar) {
        setTimeout(() => iniciarBaileys(), 4000);
      } else {
        console.error('[WhatsApp] Dispositivo desconectado (loggedOut). Novo QR Code necessário.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });

  sock.ev.on('messaging-history.set', async ({ messages }) => {
    console.log(`[WhatsApp] Sincronizando histórico de mensagens (${messages.length} msgs)...`);
    for (const msg of messages) {
      if (sock) await processarMensagemIndividual(msg, sock);
    }
  });
}

// ==============================================================================
// 6. Rotas da API REST do Servidor Unificado
// ==============================================================================

// Rota do Despertador (Cron Trigger do GitHub Actions)
app.get('/api/wake', async (req: Request, res: Response) => {
  console.log(`⏰ [Despertador] /api/wake acionado às ${new Date().toISOString()}`);

  // Força atualização das obras e checagem de relatórios
  if (sock && status === 'conectado') {
    try {
      await processarRelatoriosPendentes(sock);
    } catch (e) {
      console.error('[Despertador] Erro ao verificar relatórios pendentes:', e);
    }
  }

  res.json({
    status: 'awake',
    time: new Date().toISOString(),
    whatsapp: status,
    obrasMonitoradas: obrasCache.size,
  });
});

// Status da Conexão WhatsApp
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    gruposLista: Array.isArray(gruposLista) ? gruposLista : [],
  });
});

// CRUD de Obras (obras_config)
app.get('/api/obras', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.json({ sucesso: false, aviso: error.message, obras: [] });
    return res.json({ sucesso: true, obras: data || [] });
  } catch (err: any) {
    return res.json({ sucesso: false, aviso: err.message, obras: [] });
  }
});

app.post('/api/obras', async (req: Request, res: Response) => {
  try {
    const { obra_id, nome_obra, responsaveis, ativa } = req.body;
    if (!obra_id || !nome_obra) {
      return res.status(400).json({ error: 'Campos obra_id e nome_obra são obrigatórios.' });
    }

    const responsaveisTratados = Array.isArray(responsaveis)
      ? responsaveis.map((n: string) => String(n).replace(/\D/g, '')).filter(Boolean)
      : [];

    const { data, error } = await supabase
      .from('obras_config')
      .upsert(
        [
          {
            obra_id,
            nome_obra: String(nome_obra).trim(),
            responsaveis: responsaveisTratados,
            ativa: ativa !== undefined ? Boolean(ativa) : true,
          },
        ],
        { onConflict: 'obra_id' }
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await carregarObrasMonitoradas(true);
    return res.status(201).json({ sucesso: true, obra: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/obras/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('obras_config').delete().eq('obra_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    await carregarObrasMonitoradas(true);
    return res.json({ sucesso: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Eventos formatados para o FullCalendar
app.get('/api/agenda/:obra_id', async (req: Request, res: Response) => {
  try {
    const obraId = req.params.obra_id;
    const { data, error } = await supabase
      .from('agenda_obra')
      .select('*')
      .eq('obra_id', obraId)
      .order('data_evento', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const eventosFullCalendar = (data || []).map((ev: any) => {
      const horario = ev.horario && ev.horario.includes(':') ? ev.horario : '08:00';
      return {
        id: ev.id,
        title: `${horario} - ${ev.descricao}`,
        start: `${ev.data_evento}T${horario}:00`,
        allDay: !ev.horario,
        extendedProps: { descricao: ev.descricao, horario: ev.horario, obra_id: ev.obra_id },
      };
    });

    return res.json(eventosFullCalendar);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Rota raiz (Frontend SPA em public/index.html)
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==============================================================================
// 7. Inicialização do Servidor Unificado (Render Web Service)
// ==============================================================================
app.listen(PORT, () => {
  console.log('\n=============================================================');
  console.log('🚀 [GADAP Hub] SERVIDOR UNIFICADO ONLINE (RENDER WEB SERVICE)');
  console.log(`🌐 Porta aberta e escutando: ${PORT}`);
  console.log(`⏰ Rota do despertador pronta: /api/wake`);
  console.log('=============================================================\n');

  iniciarBaileys();
});
