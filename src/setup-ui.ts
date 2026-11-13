import express, { Request, Response } from 'express';
import makeWASocket, { DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
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

export interface EventoAgenda {
  id: string;
  obra_id: string;
  data_evento: string;
  horario: string;
  descricao: string;
  created_at?: string;
}

let status: StatusConexao = 'desconectado';
let qrCodeImage: string | null = null;
let gruposLista: GrupoInfo[] = [];
let sock: WASocket | null = null;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

app.use(express.json());

// ==============================================================================
// Integração Baileys
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
// API Endpoints
// ==============================================================================

app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    gruposLista: Array.isArray(gruposLista) ? gruposLista : [],
  });
});

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

app.post('/api/obras', async (req: Request, res: Response) => {
  try {
    const { obra_id, nome_obra, responsaveis, ativa } = req.body;

    if (!obra_id || !nome_obra) {
      return res.status(400).json({ error: 'obra_id e nome_obra são obrigatórios.' });
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

app.delete('/api/obras/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('obras_config').delete().eq('obra_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ sucesso: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/agenda: Lista geral de agendamentos
app.get('/api/agenda', async (req: Request, res: Response) => {
  try {
    const obraId = req.query.obra_id as string;
    let query = supabase.from('agenda_obra').select('*').order('data_evento', { ascending: true }).order('horario', { ascending: true });

    if (obraId) {
      query = query.eq('obra_id', obraId);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// MÓDULO 1: GET /api/agenda/:obra_id formatado no padrão exigido pelo FullCalendar
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

    // Mapeamento padrão do FullCalendar ({ id, title, start, end, allDay })
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

app.delete('/api/agenda/:id', async (req: Request, res: Response) => {
  try {
    const { error } = await supabase.from('agenda_obra').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ sucesso: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// Dashboard Embutido (Com Abas: Obras, Lista de Agenda e FullCalendar)
// ==============================================================================
app.get('/', (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GADAP Hub - Gestão de Obras & FullCalendar</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- FullCalendar CDN -->
  <script src="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    .custom-scroll::-webkit-scrollbar { width: 6px; }
    .custom-scroll::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.6); }
    .custom-scroll::-webkit-scrollbar-thumb { background: rgba(51, 65, 85, 0.8); border-radius: 4px; }
    
    /* Customização Tema Escuro do FullCalendar */
    .fc { --fc-border-color: #334155; --fc-page-bg-color: transparent; }
    .fc-theme-standard th { background: #0f172a; padding: 10px; font-size: 12px; color: #94a3b8; }
    .fc-theme-standard td { border-color: #1e293b; }
    .fc-daygrid-day-number { color: #cbd5e1; font-size: 12px; font-weight: 600; padding: 6px !important; }
    .fc-col-header-cell-cushion { color: #94a3b8; text-transform: uppercase; font-size: 11px; }
    .fc-event { background: linear-gradient(135deg, #059669, #0d9488); border: none; border-radius: 6px; padding: 3px 6px; font-size: 11px; font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
    .fc-button-primary { background-color: #1e293b !important; border-color: #334155 !important; font-size: 12px !important; font-weight: 600 !important; border-radius: 8px !important; }
    .fc-button-primary:hover { background-color: #334155 !important; }
    .fc-button-active { background-color: #2563eb !important; border-color: #2563eb !important; }
    .fc-toolbar-title { font-size: 16px !important; font-weight: 700; color: #ffffff; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col py-6 px-4 sm:px-8">

  <!-- Header & Navegação em 3 Abas -->
  <header class="w-full max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-800 gap-4">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
        G
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          GADAP Hub
          <span class="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Multi-Obras</span>
        </h1>
        <p class="text-xs text-slate-400">Inteligência Operacional & Calendário de Obras</p>
      </div>
    </div>

    <!-- Navegação por Abas -->
    <div class="flex items-center gap-1.5 bg-slate-900 border border-slate-800 p-1.5 rounded-xl">
      <button onclick="trocarAba('obras')" id="tab-obras" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow transition">
        Obras & WhatsApp
      </button>
      <button onclick="trocarAba('calendario')" id="tab-calendario" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition">
        Visão de Calendário
      </button>
      <button onclick="trocarAba('agenda')" id="tab-agenda" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition">
        Lista de Eventos
      </button>
    </div>

    <div id="badge-status" class="px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-slate-800 text-slate-400 border border-slate-700 self-start md:self-auto">
      <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
      <span id="badge-texto">Carregando status...</span>
    </div>
  </header>

  <!-- Container Principal -->
  <main class="w-full max-w-7xl mx-auto mt-6 flex-1 flex flex-col">

    <!-- ABA 1: CONFIGURAÇÃO DE OBRAS E WHATSAPP -->
    <div id="conteudo-obras" class="flex-1 flex flex-col">
      <!-- Desconectado -->
      <section id="card-desconectado" class="w-full max-w-md mx-auto my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl hidden">
        <div class="w-14 h-14 bg-slate-800 rounded-2xl mx-auto flex items-center justify-center mb-4">
          <svg class="w-7 h-7 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
        </div>
        <h2 class="text-lg font-semibold text-white">Conectando ao WhatsApp</h2>
        <p class="text-xs text-slate-400 mt-2">Carregando credenciais criptográficas do Supabase...</p>
      </section>

      <!-- QR Code -->
      <section id="card-qr" class="w-full max-w-md mx-auto my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl hidden">
        <span class="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
          Autenticação Requerida
        </span>
        <h2 class="text-xl font-bold text-white mt-4">Escaneie o QR Code</h2>
        <p class="text-xs text-slate-400 mt-1 mb-6">WhatsApp &gt; Aparelhos Conectados &gt; Conectar um Aparelho</p>
        <div class="p-3 bg-white rounded-2xl shadow-inner inline-block mx-auto border-4 border-slate-800">
          <img id="qr-img" class="w-64 h-64 rounded-lg block" src="" alt="QR Code WhatsApp" />
        </div>
      </section>

      <!-- Split View Obras -->
      <section id="card-conectado" class="w-full grid grid-cols-1 lg:grid-cols-2 gap-8 hidden flex-1">
        <!-- Grupos WhatsApp -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col h-[650px]">
          <div class="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h2 class="text-base font-bold text-white flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50"></span>
                Grupos Disponíveis no WhatsApp
              </h2>
              <p class="text-xs text-slate-400 mt-0.5">Grupos identificados na conta conectada</p>
            </div>
            <span id="grupos-count" class="text-xs font-semibold px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg border border-slate-700">0 grupos</span>
          </div>
          <ul id="grupos-lista" class="mt-4 flex-1 overflow-y-auto custom-scroll pr-1 space-y-2.5">
            <li class="py-12 text-center text-slate-500 text-xs">Carregando grupos do WhatsApp...</li>
          </ul>
        </div>

        <!-- Obras Monitorizadas -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col h-[650px]">
          <div class="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h2 class="text-base font-bold text-white flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-md shadow-blue-500/50"></span>
                Obras Monitorizadas (Supabase)
              </h2>
              <p class="text-xs text-slate-400 mt-0.5">Obras ativas que o bot lê mensagens e envia relatórios</p>
            </div>
            <span id="obras-count" class="text-xs font-semibold px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/30">0 monitoradas</span>
          </div>
          <ul id="obras-lista" class="mt-4 flex-1 overflow-y-auto custom-scroll pr-1 space-y-2.5">
            <li class="py-12 text-center text-slate-500 text-xs">Carregando obras do Supabase...</li>
          </ul>
        </div>
      </section>
    </div>

    <!-- ABA 2: MÓDULO 1 - VISÃO DE CALENDÁRIO VISUAL COM FULLCALENDAR -->
    <div id="conteudo-calendario" class="flex-1 flex flex-col hidden">
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex-1 flex flex-col">
        <!-- Barra de Seleção de Obra para o Calendário -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-slate-800 gap-4">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              📅 Calendário Visual das Obras
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Selecione uma obra para ver as entregas e frentes de serviço no calendário</p>
          </div>
          <div class="flex items-center gap-3">
            <select id="select-obra-calendario" onchange="atualizarCalendario()" class="bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-semibold">
              <option value="">Selecione uma Obra...</option>
            </select>
          </div>
        </div>

        <!-- Container do FullCalendar -->
        <div class="mt-5 flex-1 min-h-[550px] p-2 bg-slate-950/50 rounded-xl border border-slate-800/80">
          <div id="calendar"></div>
        </div>
      </div>
    </div>

    <!-- ABA 3: LISTA CRONOLÓGICA DE EVENTOS -->
    <div id="conteudo-agenda" class="flex-1 flex flex-col hidden">
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex-1 flex flex-col">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-slate-800 gap-4">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              📋 Lista de Agendamentos Cadastrados
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Todos os agendamentos registrados no banco de dados</p>
          </div>
          <div class="flex items-center gap-3">
            <select id="filtro-obra-agenda" onchange="carregarAgenda()" class="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
              <option value="">Todas as Obras</option>
            </select>
            <button onclick="carregarAgenda()" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition">
              Atualizar
            </button>
          </div>
        </div>

        <div class="mt-4 flex-1 overflow-x-auto custom-scroll">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="text-[11px] uppercase bg-slate-950/80 text-slate-400 border-b border-slate-800">
              <tr>
                <th class="py-3 px-4 rounded-l-lg">Data</th>
                <th class="py-3 px-4">Horário</th>
                <th class="py-3 px-4">Obra</th>
                <th class="py-3 px-4">Compromisso / Descrição</th>
                <th class="py-3 px-4 text-right rounded-r-lg">Ação</th>
              </tr>
            </thead>
            <tbody id="agenda-tbody" class="divide-y divide-slate-800/60">
              <tr><td colspan="5" class="py-8 text-center text-slate-500">Carregando cronograma...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </main>

  <!-- Modal de Configuração de Obra -->
  <div id="modal-obra" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm hidden p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
      <div class="flex items-center justify-between pb-4 border-b border-slate-800">
        <h3 class="text-base font-bold text-white flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-blue-500"></span>
          Configurar Monitoramento da Obra
        </h3>
        <button onclick="fecharModal()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 text-sm">✕</button>
      </div>

      <form id="form-obra" onsubmit="salvarObra(event)" class="mt-5 space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Nome da Obra</label>
          <input type="text" id="modal-nome" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-sans" placeholder="Ex: Obra Leopoldo" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">ID do Grupo WhatsApp (JID)</label>
          <input type="text" id="modal-id" readonly class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-xs font-mono text-emerald-400 select-all cursor-not-allowed" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Telefones dos Responsáveis (Separados por vírgula)</label>
          <textarea id="modal-responsaveis" rows="3" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500 font-mono" placeholder="5511988139833, 5511978543369"></textarea>
          <p class="text-[11px] text-slate-500 mt-1">Os responsáveis recebem o infográfico semanal e diário em imagem no privado.</p>
        </div>

        <div class="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="fecharModal()" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 transition">Cancelar</button>
          <button type="submit" id="btn-salvar" class="px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition">Salvar Obra</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-6 right-6 bg-slate-900 border border-slate-700 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-2 transition-all duration-300 transform translate-y-20 opacity-0 pointer-events-none z-50">
    <span id="toast-icon">✨</span>
    <span id="toast-msg">Mensagem</span>
  </div>

  <script>
    let cacheGrupos = [];
    let cacheObras = [];
    let calendarInstance = null;

    function trocarAba(aba) {
      const btnObras = document.getElementById('tab-obras');
      const btnCalendario = document.getElementById('tab-calendario');
      const btnAgenda = document.getElementById('tab-agenda');

      const viewObras = document.getElementById('conteudo-obras');
      const viewCalendario = document.getElementById('conteudo-calendario');
      const viewAgenda = document.getElementById('conteudo-agenda');

      const abas = [
        { id: 'obras', btn: btnObras, view: viewObras },
        { id: 'calendario', btn: btnCalendario, view: viewCalendario },
        { id: 'agenda', btn: btnAgenda, view: viewAgenda }
      ];

      abas.forEach(a => {
        if (a.id === aba) {
          a.btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow transition';
          a.view.classList.remove('hidden');
        } else {
          a.btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition';
          a.view.classList.add('hidden');
        }
      });

      if (aba === 'calendario') {
        inicializarOuAtualizarCalendario();
      } else if (aba === 'agenda') {
        carregarAgenda();
      }
    }

    function inicializarOuAtualizarCalendario() {
      const calendarEl = document.getElementById('calendar');
      if (!calendarInstance) {
        calendarInstance = new FullCalendar.Calendar(calendarEl, {
          initialView: 'dayGridMonth',
          locale: 'pt-br',
          headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,listWeek'
          },
          buttonText: {
            today: 'Hoje',
            month: 'Mês',
            week: 'Semana',
            list: 'Lista'
          },
          events: [],
          eventClick: function(info) {
            alert('📌 ' + info.event.title + '\\nObra: ' + (info.event.extendedProps.obra_id || ''));
          }
        });
        calendarInstance.render();
      } else {
        calendarInstance.render();
      }
      atualizarCalendario();
    }

    async function atualizarCalendario() {
      const obraId = document.getElementById('select-obra-calendario').value;
      if (!calendarInstance) return;

      if (!obraId) {
        calendarInstance.removeAllEvents();
        return;
      }

      try {
        const res = await fetch('/api/agenda/' + encodeURIComponent(obraId));
        const eventos = await res.json();
        calendarInstance.removeAllEvents();
        calendarInstance.addEventSource(eventos);
      } catch (err) {
        console.error('Erro ao carregar eventos no FullCalendar:', err);
      }
    }

    function showToast(msg, icon = '✨') {
      const toast = document.getElementById('toast');
      document.getElementById('toast-msg').innerText = msg;
      document.getElementById('toast-icon').innerText = icon;
      toast.classList.remove('translate-y-20', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
      setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 3000);
    }

    function abrirModal(id, nome) {
      document.getElementById('modal-id').value = id;
      document.getElementById('modal-nome').value = nome || '';
      const obra = cacheObras.find(o => o.obra_id === id);
      document.getElementById('modal-responsaveis').value = obra?.responsaveis ? obra.responsaveis.join(', ') : '';
      document.getElementById('modal-obra').classList.remove('hidden');
    }

    function fecharModal() {
      document.getElementById('modal-obra').classList.add('hidden');
    }

    async function salvarObra(e) {
      e.preventDefault();
      const btn = document.getElementById('btn-salvar');
      btn.innerText = 'Salvando...';
      btn.disabled = true;

      const obra_id = document.getElementById('modal-id').value;
      const nome_obra = document.getElementById('modal-nome').value;
      const responsaveis = document.getElementById('modal-responsaveis').value.split(',').map(s => s.trim()).filter(Boolean);

      try {
        const res = await fetch('/api/obras', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obra_id, nome_obra, responsaveis, ativa: true })
        });
        const json = await res.json();
        if (res.ok && json.sucesso) {
          fecharModal();
          showToast('Obra salva com sucesso!', '✅');
          await carregarObras();
          renderGrupos();
        } else {
          alert('Erro ao salvar obra: ' + (json.error || 'Erro desconhecido'));
        }
      } catch {
        alert('Erro de conexão ao salvar obra.');
      } finally {
        btn.innerText = 'Salvar Obra';
        btn.disabled = false;
      }
    }

    async function removerObra(obraId, nome) {
      if (!confirm('Deseja remover o monitoramento da obra "' + nome + '"?')) return;
      try {
        const res = await fetch('/api/obras/' + encodeURIComponent(obraId), { method: 'DELETE' });
        if (res.ok) {
          showToast('Obra removida.', '🗑️');
          await carregarObras();
          renderGrupos();
        }
      } catch {
        alert('Erro ao remover obra.');
      }
    }

    async function excluirEventoAgenda(id, descricao) {
      if (!confirm('Deseja excluir o agendamento "' + descricao + '"?')) return;
      try {
        const res = await fetch('/api/agenda/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.ok) {
          showToast('Evento excluído.', '🗑️');
          await carregarAgenda();
          if (calendarInstance) atualizarCalendario();
        }
      } catch {
        alert('Erro ao excluir evento.');
      }
    }

    function renderGrupos() {
      const listaEl = document.getElementById('grupos-lista');
      const countEl = document.getElementById('grupos-count');
      const grupos = Array.isArray(cacheGrupos) ? cacheGrupos : [];
      countEl.innerText = grupos.length + ' grupos';

      if (grupos.length === 0) {
        listaEl.innerHTML = '<li class="py-12 text-center text-slate-500 text-xs">Nenhum grupo encontrado nesta conta.</li>';
        return;
      }

      listaEl.innerHTML = grupos.map(g => {
        const obra = cacheObras.find(o => o.obra_id === g.id);
        const jaConfigurada = !!obra;
        const nomeExibicao = jaConfigurada ? obra.nome_obra : g.subject;

        return \`
          <li class="bg-slate-950/70 border \${jaConfigurada ? 'border-emerald-500/40 bg-emerald-950/10' : 'border-slate-800'} rounded-xl p-3.5 flex items-center justify-between gap-3 hover:border-slate-700 transition">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="font-medium text-white text-xs truncate">\${nomeExibicao}</p>
                \${jaConfigurada ? '<span class="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 text-[9px] rounded font-semibold uppercase">Monitorada</span>' : ''}
              </div>
              <p class="text-[11px] font-mono text-slate-500 truncate mt-0.5">\${g.id}</p>
            </div>
            <button onclick="abrirModal('\${g.id}', '\${nomeExibicao.replace(/'/g, "\\\\'")}')" class="px-3 py-1.5 rounded-lg \${jaConfigurada ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/30'} font-semibold text-xs whitespace-nowrap transition">
              \${jaConfigurada ? 'Editar' : 'Configurar'}
            </button>
          </li>
        \`;
      }).join('');
    }

    function renderObras() {
      const listaEl = document.getElementById('obras-lista');
      const countEl = document.getElementById('obras-count');
      const filtroEl = document.getElementById('filtro-obra-agenda');
      const selectCalendarioEl = document.getElementById('select-obra-calendario');
      const obras = Array.isArray(cacheObras) ? cacheObras : [];
      countEl.innerText = obras.length + ' monitoradas';

      filtroEl.innerHTML = '<option value="">Todas as Obras</option>' + obras.map(o => \`<option value="\${o.obra_id}">\${o.nome_obra}</option>\`).join('');
      selectCalendarioEl.innerHTML = '<option value="">Selecione uma Obra...</option>' + obras.map(o => \`<option value="\${o.obra_id}">\${o.nome_obra}</option>\`).join('');

      if (obras.length === 0) {
        listaEl.innerHTML = '<li class="py-12 text-center text-slate-500 text-xs border border-dashed border-slate-800/80 rounded-xl p-6">Nenhuma obra monitorizada ainda.</li>';
        return;
      }

      listaEl.innerHTML = obras.map(o => \`
        <li class="bg-slate-950/80 border border-slate-800 hover:border-blue-500/40 rounded-xl p-4 transition-all flex flex-col gap-2.5">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h4 class="font-bold text-white text-xs truncate">\${o.nome_obra}</h4>
              <p class="text-[11px] font-mono text-emerald-400 truncate mt-0.5 select-all">\${o.obra_id}</p>
            </div>
            <button onclick="removerObra('\${o.obra_id}', '\${o.nome_obra.replace(/'/g, "\\\\'")}')" class="text-xs px-2.5 py-1 text-rose-400 hover:bg-rose-500/10 rounded-lg border border-rose-500/20 transition whitespace-nowrap">
              Remover
            </button>
          </div>
          <div class="text-xs text-slate-400 flex items-center gap-2 pt-2 border-t border-slate-800/60">
            <span class="text-[11px] text-slate-500 whitespace-nowrap">Responsáveis:</span>
            <div class="flex flex-wrap gap-1">
              \${o.responsaveis && o.responsaveis.length > 0 
                ? o.responsaveis.map(r => \`<span class="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-slate-300">\${r}</span>\`).join('')
                : '<span class="text-slate-600 text-[11px]">Apenas no grupo</span>'
              }
            </div>
          </div>
        </li>
      \`).join('');
    }

    async function carregarObras() {
      try {
        const res = await fetch('/api/obras');
        const json = await res.json();
        cacheObras = Array.isArray(json.obras) ? json.obras : [];
        renderObras();
      } catch (err) {
        console.error(err);
      }
    }

    async function carregarAgenda() {
      const obraId = document.getElementById('filtro-obra-agenda').value;
      const tbody = document.getElementById('agenda-tbody');
      tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500">Buscando agendamentos...</td></tr>';

      try {
        const url = obraId ? '/api/agenda?obra_id=' + encodeURIComponent(obraId) : '/api/agenda';
        const res = await fetch(url);
        const eventos = await res.json();

        if (!Array.isArray(eventos) || eventos.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="py-10 text-center text-slate-500">Nenhum evento registrado.</td></tr>';
          return;
        }

        tbody.innerHTML = eventos.map(ev => {
          const obra = cacheObras.find(o => o.obra_id === ev.obra_id);
          const nomeObra = obra ? obra.nome_obra : 'Obra Desconhecida';
          const [ano, mes, dia] = ev.data_evento.split('-');

          return \`
            <tr class="hover:bg-slate-900/60 transition-colors">
              <td class="py-3 px-4 font-mono font-medium text-emerald-400">\${dia}/\${mes}/\${ano}</td>
              <td class="py-3 px-4 font-mono text-slate-300">\${ev.horario}</td>
              <td class="py-3 px-4 font-medium text-white">\${nomeObra}</td>
              <td class="py-3 px-4 text-slate-200">\${ev.descricao}</td>
              <td class="py-3 px-4 text-right">
                <button onclick="excluirEventoAgenda('\${ev.id}', '\${ev.descricao.replace(/'/g, "\\\\'")}')" class="px-2.5 py-1 text-rose-400 hover:bg-rose-500/10 rounded-lg border border-rose-500/20 text-[11px] transition">
                  Excluir
                </button>
              </td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-rose-400">Erro ao carregar agenda.</td></tr>';
      }
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        const badge = document.getElementById('badge-status');
        const cardDesconectado = document.getElementById('card-desconectado');
        const cardQr = document.getElementById('card-qr');
        const cardConectado = document.getElementById('card-conectado');
        const qrImg = document.getElementById('qr-img');

        if (data.status === 'desconectado') {
          badge.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-amber-500/10 text-amber-400 border border-amber-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span><span>Conectando...</span>';
          cardDesconectado.classList.remove('hidden');
          cardQr.classList.add('hidden');
          cardConectado.classList.add('hidden');
        } else if (data.status === 'qr') {
          badge.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-blue-500/10 text-blue-400 border border-blue-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span><span>Aguardando Scan</span>';
          cardDesconectado.classList.add('hidden');
          cardQr.classList.remove('hidden');
          cardConectado.classList.add('hidden');
          if (data.qrCodeImage) qrImg.src = data.qrCodeImage;
        } else if (data.status === 'conectado') {
          badge.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>WhatsApp Conectado</span>';
          cardDesconectado.classList.add('hidden');
          cardQr.classList.add('hidden');
          cardConectado.classList.remove('hidden');

          cacheGrupos = Array.isArray(data.gruposLista) ? data.gruposLista : [];
          renderGrupos();
        }
      } catch (err) {
        console.error(err);
      }
    }

    setInterval(pollStatus, 2500);
    pollStatus();
    carregarObras();
  </script>
</body>
</html>`;

  res.send(html);
});

// ==============================================================================
// Inicialização do Servidor Local
// ==============================================================================
app.listen(PORT, () => {
  console.log('\n======================================================');
  console.log('🚀 [GADAP Hub] Setup UI & FullCalendar Manager Online!');
  console.log(`🌐 Acesse no navegador: http://localhost:${PORT}`);
  console.log('======================================================\n');
  iniciarBaileysSetup();
});
