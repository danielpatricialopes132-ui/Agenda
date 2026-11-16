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
import {
  extrairAgendamento,
  detectarConflitosAgenda,
  extrairMultiplosEventosTexto,
  gerarSolucaoEngenharia,
} from './lib/aiProcessor';
import { gerarImagemAgendaSemana, EventoRelatorio } from './lib/reportGenerator';
import { gerarAudioBriefing } from './lib/audioBriefing';
import { acquireLock, startHeartbeat, releaseLock } from './lib/mutex';

dotenv.config();

// Identificação da Instância Distribuída
const instanceName = process.env.RENDER ? 'render-prod' : 'local-dev';

// ==============================================================================
// 1. Estado Global da Aplicação
// ==============================================================================
type StatusConexao = 'desconectado' | 'qr' | 'conectado' | 'modo_leitura';

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
        nome_obra: item.nome_obra || 'Obra Sem Nome',
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

    return !data;
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
    return !data;
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
// 3. Motor de Disparos de Relatórios (Multi-Obras com Clean Name Obrigatório)
// ==============================================================================
async function processarRelatoriosPendentes(client: WASocket): Promise<void> {
  const obras = await carregarObrasMonitoradas(true);
  if (obras.size === 0) return;

  const agora = new Date();
  const diaSemana = agora.getDay();
  const hora = agora.getHours();
  const hojeIso = agora.toISOString().split('T')[0];

  console.log(`[Relatórios] Verificando regras de envio: Dia=${diaSemana}, Hora=${hora}h, Data=${hojeIso}`);

  for (const [obraId, configObra] of obras.entries()) {
    const cleanName = configObra.nome_obra?.trim() || 'Obra Sem Nome';

    // 1. Segunda-feira pela manhã (entre 07:00 e 11:59): Infográfico Semanal em Imagem
    if (diaSemana === 1 && hora >= 7 && hora <= 11) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'SEMANAL', hojeIso);
      if (!jaEnviado) {
        const em5Dias = new Date();
        em5Dias.setDate(agora.getDate() + 5);
        const dataFimIso = em5Dias.toISOString().split('T')[0];

        const eventos = await buscarEventosPorIntervalo(obraId, hojeIso, dataFimIso);

        try {
          const imagemBuffer = await gerarImagemAgendaSemana(cleanName, eventos, 'SEMANAL');
          const caption = `📋 *Resumo da Semana - ${cleanName}*\nResumo da agenda atualizado. Bom trabalho à equipe!`;

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
          console.log(`✅ Infográfico semanal disparado para "${cleanName}".`);
        } catch (imgErr) {
          console.error(`[Relatórios] Falha ao enviar infográfico semanal para "${cleanName}":`, imgErr);
        }
      }
    }

    // 2. Terça a Sexta pela manhã (entre 06:00 e 09:59): Lembretes do Dia em Imagem + Áudio TTS
    if (diaSemana >= 2 && diaSemana <= 5 && hora >= 6 && hora <= 9) {
      const jaEnviado = await relatorioJaEnviado(obraId, 'DIARIO', hojeIso);
      if (!jaEnviado) {
        const eventos = await buscarEventosDoDia(obraId, hojeIso);

        try {
          const imagemBuffer = await gerarImagemAgendaSemana(cleanName, eventos, 'DIARIO');
          const caption = `🌅 *Lembretes do Dia - ${cleanName}*\nResumo da agenda atualizado. Bom trabalho à equipe!`;
          await client.sendMessage(obraId, { image: imagemBuffer, caption });

          try {
            const audioBuffer = await gerarAudioBriefing(eventos, cleanName);
            await client.sendMessage(obraId, {
              audio: audioBuffer,
              mimetype: 'audio/mp4',
              ptt: true,
            });
            console.log(`🎙️ Morning Briefing em áudio enviado para "${cleanName}".`);
          } catch (audioErr) {
            console.warn(`[Relatórios] Falha ao enviar áudio TTS para "${cleanName}":`, audioErr);
          }

          for (const telefone of configObra.responsaveis) {
            const numeroLimpo = telefone.replace(/\D/g, '');
            if (numeroLimpo.length >= 10) {
              try {
                await client.sendMessage(`${numeroLimpo}@s.whatsapp.net`, { image: imagemBuffer, caption });
              } catch {}
            }
          }

          await marcarRelatorioEnviado(obraId, 'DIARIO', hojeIso);
          console.log(`✅ Lembretes diários disparados para "${cleanName}".`);
        } catch (imgErr) {
          console.error(`[Relatórios] Falha ao enviar lembretes diários para "${cleanName}":`, imgErr);
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

  const cleanName = configObra.nome_obra?.trim() || 'Obra Sem Nome';
  console.log(`[WhatsApp - ${cleanName}]: "${texto}"`);

  // Extração via IA (Gemini)
  const hoje = new Date();
  const hojeIso = hoje.toISOString().split('T')[0];
  const resultado = await extrairAgendamento(texto, hojeIso);

  if (resultado.is_agendamento && resultado.data_iso && resultado.descricao) {
    console.log(`🎯 [AI - ${cleanName}] Agendamento detectado:`, resultado);

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

        let mensagemConfirmacao = `✅ *AGENDAMENTO REGISTRADO - ${cleanName.toUpperCase()}*\n\n` +
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
let timeoutReconexao: NodeJS.Timeout | null = null;

async function iniciarBaileys() {
  if (timeoutReconexao) {
    clearTimeout(timeoutReconexao);
    timeoutReconexao = null;
  }

  console.log('[WhatsApp] Carregando sessão remota do Supabase...');
  const { state, saveCreds } = await useSupabaseAuthState('obra_principal');
  saveCredsFn = saveCreds;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
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

          await processarRelatoriosPendentes(sock);
        }
      } catch (err) {
        console.error('[WhatsApp] Erro pós-conexão:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      status = 'desconectado';
      console.warn(`[WhatsApp] Conexão encerrada (statusCode: ${statusCode}).`);

      if (!isLoggedOut) {
        const delayMs = statusCode === 440 ? 15000 : 4000;
        console.log(`[WhatsApp] Agendando reconexão em ${delayMs / 1000}s...`);
        timeoutReconexao = setTimeout(() => iniciarBaileys(), delayMs);
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
    instanceName,
    obrasMonitoradas: obrasCache.size,
  });
});

// Status da Conexão WhatsApp
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    instanceName,
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

// Cadastrar / Criar Obra (POST)
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

// Atualizar Obra / Renomear / Editar Responsáveis (PUT)
app.put('/api/obras/:id', async (req: Request, res: Response) => {
  try {
    const obraId = req.params.id;
    const { nome_obra, responsaveis, ativa } = req.body;

    if (!nome_obra || !nome_obra.trim()) {
      return res.status(400).json({ error: 'O campo nome_obra é obrigatório para atualização.' });
    }

    const updatePayload: Record<string, any> = {
      nome_obra: String(nome_obra).trim(),
    };

    if (responsaveis !== undefined) {
      updatePayload.responsaveis = Array.isArray(responsaveis)
        ? responsaveis.map((n: string) => String(n).replace(/\D/g, '')).filter(Boolean)
        : [];
    }

    if (ativa !== undefined) {
      updatePayload.ativa = Boolean(ativa);
    }

    const { data, error } = await supabase
      .from('obras_config')
      .update(updatePayload)
      .eq('obra_id', obraId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await carregarObrasMonitoradas(true);
    return res.json({ sucesso: true, obra: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Excluir Obra (DELETE)
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

// Consulta de Agendamentos (Formatado para FullCalendar + Tabela Ordenada)
app.get('/api/agenda/:obra_id', async (req: Request, res: Response) => {
  try {
    const obraId = req.params.obra_id;
    const { data, error } = await supabase
      .from('agenda_obra')
      .select('*')
      .eq('obra_id', obraId)
      .order('data_evento', { ascending: true })
      .order('horario', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const eventosFormatados = (data || []).map((ev: any) => {
      const horario = ev.horario && ev.horario.includes(':') ? ev.horario : '08:00';
      return {
        id: ev.id,
        title: `${horario} - ${ev.descricao}`,
        start: `${ev.data_evento}T${horario}:00`,
        allDay: !ev.horario,
        data_evento: ev.data_evento,
        horario: ev.horario || 'Comercial',
        descricao: ev.descricao,
        obra_id: ev.obra_id,
        created_at: ev.created_at,
        extendedProps: {
          data_evento: ev.data_evento,
          descricao: ev.descricao,
          horario: ev.horario,
          obra_id: ev.obra_id,
        },
      };
    });

    return res.json(eventosFormatados);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// 7. NOVAS FEATURES INTELIGENTES: CHAT DE PROCESSAMENTO E CHAT DE ENGENHARIA
// ==============================================================================

/**
 * Endpoint 1: Processador de Texto Externo (SMS / E-mails / Minutas)
 * Analisa o texto, extrai datas/eventos e sugere a obra correspondente.
 */
app.post('/api/ai/processar-texto', async (req: Request, res: Response) => {
  try {
    const { texto } = req.body;
    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ sucesso: false, error: 'O texto a ser analisado é obrigatório.' });
    }

    const mapaObras = await carregarObrasMonitoradas();
    const listaObras = Array.from(mapaObras.values()).map(o => ({
      obra_id: o.obra_id,
      nome_obra: o.nome_obra,
    }));

    const hojeIso = new Date().toISOString().split('T')[0];
    const resultado = await extrairMultiplosEventosTexto(String(texto), hojeIso, listaObras);

    return res.json({
      sucesso: true,
      data: resultado,
      obras_disponiveis: listaObras,
    });
  } catch (err: any) {
    console.error('[API] Erro ao processar texto externo:', err);
    return res.status(500).json({ sucesso: false, error: err?.message || 'Erro ao processar texto com IA.' });
  }
});

/**
 * Endpoint 2: Confirmação e Inserção de Agendamentos Extraídos para a Obra Selecionada
 */
app.post('/api/ai/confirmar-agendamentos', async (req: Request, res: Response) => {
  try {
    const { obra_id, eventos } = req.body;

    if (!obra_id) {
      return res.status(400).json({ sucesso: false, error: 'É obrigatório selecionar a obra de destino.' });
    }

    if (!Array.isArray(eventos) || eventos.length === 0) {
      return res.status(400).json({ sucesso: false, error: 'A lista de eventos está vazia.' });
    }

    const mapaObras = await carregarObrasMonitoradas();
    const configObra = mapaObras.get(obra_id);
    const cleanName = configObra?.nome_obra || 'Obra';

    const registrosParaInserir = eventos.map((ev: any) => ({
      obra_id,
      data_evento: ev.data_iso,
      horario: ev.horario || '08:00',
      descricao: ev.descricao,
    }));

    const { data, error } = await supabase
      .from('agenda_obra')
      .insert(registrosParaInserir)
      .select();

    if (error) {
      return res.status(500).json({ sucesso: false, error: error.message });
    }

    // Opcional: Se o bot estiver conectado, envia notificação no grupo da obra
    if (sock && status === 'conectado') {
      try {
        let msgNotificacao = `📋 *NOVOS AGENDAMENTOS REGISTRADOS VIA PAINEL*\n*Obra:* ${cleanName.toUpperCase()}\n\n`;
        eventos.forEach((ev: any, i: number) => {
          const [ano, mes, dia] = (ev.data_iso || '').split('-');
          const dataFmt = (dia && mes && ano) ? `${dia}/${mes}/${ano}` : ev.data_iso;
          msgNotificacao += `${i + 1}. 🗓️ *${dataFmt}* às *${ev.horario || 'Comercial'}*: ${ev.descricao}\n`;
        });
        await sock.sendMessage(obra_id, { text: msgNotificacao.trim() });
      } catch (waErr) {
        console.warn('[WhatsApp] Não foi possível enviar notificação de agendamento em lote:', waErr);
      }
    }

    return res.json({
      sucesso: true,
      mensagem: `${eventos.length} agendamento(s) inserido(s) com sucesso na obra "${cleanName}".`,
      inseridos: data,
    });
  } catch (err: any) {
    console.error('[API] Erro ao confirmar agendamentos em lote:', err);
    return res.status(500).json({ sucesso: false, error: err?.message || 'Erro ao persistir agendamentos.' });
  }
});

/**
 * Endpoint 3: Chat de Engenharia de Soluções (Ticket Generator + Prompt IDE)
 */
app.post('/api/ai/engenharia-solucoes', async (req: Request, res: Response) => {
  try {
    const { descricao, historico } = req.body;

    if (!descricao || !String(descricao).trim()) {
      return res.status(400).json({ sucesso: false, error: 'A descrição da necessidade é obrigatória.' });
    }

    const solucao = await gerarSolucaoEngenharia(String(descricao), historico || '');

    return res.json({
      sucesso: true,
      solucao,
    });
  } catch (err: any) {
    console.error('[API] Erro no gerador de soluções:', err);
    return res.status(500).json({ sucesso: false, error: err?.message || 'Falha ao sintetizar solução técnica.' });
  }
});

// Rota raiz (Frontend SPA em public/index.html)
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==============================================================================
// 8. Inicialização do Servidor com Trava Lógica (Distributed Mutex)
// ==============================================================================
app.listen(PORT, async () => {
  console.log('\n=============================================================');
  console.log(`🚀 [GADAP Hub] SERVIDOR UNIFICADO ONLINE [${instanceName.toUpperCase()}]`);
  console.log(`🌐 Porta aberta e escutando: ${PORT}`);
  console.log(`⏰ Rota do despertador pronta: /api/wake`);
  console.log('=============================================================\n');

  console.log(`[MUTEX] Verificando posse do lock para a instância "${instanceName}"...`);
  const canStartBot = await acquireLock(instanceName);

  if (canStartBot) {
    console.log(`✅ [MUTEX] Lock concedido! Iniciando conexão Baileys e Heartbeat...`);
    startHeartbeat(instanceName);
    iniciarBaileys();
  } else {
    status = 'modo_leitura';
    console.warn('⚠️ [MUTEX] WhatsApp já está conectado noutra instância. Iniciando apenas o Dashboard (Modo Leitura).');
  }
});

// Graceful shutdown liberando lock
process.on('SIGTERM', async () => {
  console.log(`[Server] Recebido SIGTERM. Liberando lock de "${instanceName}"...`);
  await releaseLock(instanceName);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log(`[Server] Recebido SIGINT. Liberando lock de "${instanceName}"...`);
  await releaseLock(instanceName);
  process.exit(0);
});
