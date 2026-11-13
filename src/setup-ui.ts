import express, { Request, Response } from 'express';
import makeWASocket, { DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';
import { useSupabaseAuthState, supabase } from './lib/useSupabaseAuthState';

dotenv.config();

// ==============================================================================
// Tipos & Estado Global em Memória
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

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

app.use(express.json());

// Serve arquivos estáticos da pasta public/ (incluindo o novo index.html SaaS)
app.use(express.static(path.join(__dirname, '../public')));

// ==============================================================================
// Integração Baileys (Sessão Remota via Supabase)
// ==============================================================================
async function iniciarBaileysSetup() {
  console.log('[Setup UI] Carregando credenciais do Supabase...');
  const { state, saveCreds } = await useSupabaseAuthState('obra_principal');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'qr';
      try {
        qrCodeImage = await QRCode.toDataURL(qr);
        console.log('[Setup UI] Novo QR Code gerado.');
      } catch (err) {
        console.error('[Setup UI] Falha ao converter QR Code:', err);
      }
    }

    if (connection === 'open') {
      status = 'conectado';
      qrCodeImage = null;
      console.log('✅ [Setup UI] WhatsApp conectado! Carregando grupos participantes...');

      try {
        if (sock) {
          const grupos = await sock.groupFetchAllParticipating();
          gruposLista = Object.values(grupos).map((g) => ({
            id: g.id,
            subject: g.subject || 'Sem Nome',
            participantsCount: g.participants?.length || 0,
          }));
          console.log(`[Setup UI] ${gruposLista.length} grupos carregados com sucesso!`);
        }
      } catch (groupErr) {
        console.error('[Setup UI] Erro ao listar grupos:', groupErr);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        status = 'desconectado';
        setTimeout(() => iniciarBaileysSetup(), 3000);
      } else {
        status = 'desconectado';
      }
    }
  });
}

// ==============================================================================
// API Endpoints Robustos para o SaaS Dashboard
// ==============================================================================

// 1. Status da Conexão e Lista de Grupos
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    gruposLista: Array.isArray(gruposLista) ? gruposLista : [],
  });
});

// 2. GET /api/obras: Garante retorno seguro de array
app.get('/api/obras', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.json({ sucesso: false, aviso: error.message, obras: [] });
    }

    return res.json({ sucesso: true, obras: data || [] });
  } catch (err: any) {
    return res.json({ sucesso: false, aviso: err.message, obras: [] });
  }
});

// 3. POST /api/obras: Upsert de obra com limpeza de números de telefone
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

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ sucesso: true, obra: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. DELETE /api/obras/:id: Remoção de obra
app.delete('/api/obras/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('obras_config').delete().eq('obra_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ sucesso: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. GET /api/agenda/:obra_id: Formato nativo para o FullCalendar
app.get('/api/agenda/:obra_id', async (req: Request, res: Response) => {
  try {
    const obraId = req.params.obra_id;
    const { data, error } = await supabase
      .from('agenda_obra')
      .select('*')
      .eq('obra_id', obraId)
      .order('data_evento', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const eventosFullCalendar = (data || []).map((ev: any) => {
      const horario = ev.horario && ev.horario.includes(':') ? ev.horario : '08:00';
      const startDateTime = `${ev.data_evento}T${horario}:00`;

      return {
        id: ev.id,
        title: `${horario} - ${ev.descricao}`,
        start: startDateTime,
        allDay: !ev.horario,
        extendedProps: {
          descricao: ev.descricao,
          horario: ev.horario,
          obra_id: ev.obra_id,
        },
      };
    });

    return res.json(eventosFullCalendar);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Rota raiz servindo o HTML da pasta public/
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==============================================================================
// Inicialização do Servidor Local
// ==============================================================================
app.listen(PORT, () => {
  console.log('\n======================================================');
  console.log('🚀 [GADAP Hub] SaaS Corporate Dashboard Online!');
  console.log(`🌐 Acesse no navegador: http://localhost:${PORT}`);
  console.log('======================================================\n');
  iniciarBaileysSetup();
});
