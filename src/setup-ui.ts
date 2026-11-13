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

let status: StatusConexao = 'desconectado';
let qrCodeImage: string | null = null;
let gruposLista: GrupoInfo[] = [];
let sock: WASocket | null = null;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

app.use(express.json());

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
        console.error('[Setup UI] Falha ao converter QR Code para base64:', err);
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
          console.log(`[Setup UI] ${gruposLista.length} grupos carregados.`);
        }
      } catch (groupErr) {
        console.error('[Setup UI] Erro ao listar grupos participantes:', groupErr);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.warn(`[Setup UI] Conexão encerrada (status code: ${statusCode}).`);

      if (statusCode !== DisconnectReason.loggedOut) {
        status = 'desconectado';
        setTimeout(() => iniciarBaileysSetup(), 3000);
      } else {
        status = 'desconectado';
        console.error('[Setup UI] Desconectado permanentemente (loggedOut).');
      }
    }
  });
}

// ==============================================================================
// MÓDULO 2: API Endpoints (Setup & Gerenciamento Multi-Obras)
// ==============================================================================

// 1. Status da Conexão e Lista de Grupos do WhatsApp
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    gruposLista,
  });
});

// 2. GET /api/obras: Lista todas as obras configuradas no Supabase
app.get('/api/obras', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[API] Erro ao buscar obras:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err) {
    console.error('[API] Exceção em GET /api/obras:', err);
    return res.status(500).json({ error: 'Erro interno ao consultar obras.' });
  }
});

// 3. POST /api/obras: Cria ou atualiza a configuração de uma obra
app.post('/api/obras', async (req: Request, res: Response) => {
  try {
    const { obra_id, nome_obra, responsaveis, ativa } = req.body;

    if (!obra_id || !nome_obra) {
      return res.status(400).json({ error: 'obra_id e nome_obra são obrigatórios.' });
    }

    // Normaliza os números dos responsáveis removendo caracteres não numéricos
    const responsaveisTratados: string[] = Array.isArray(responsaveis)
      ? responsaveis.map((n: string) => n.replace(/\D/g, '')).filter(Boolean)
      : [];

    const { data, error } = await supabase
      .from('obras_config')
      .upsert([
        {
          obra_id,
          nome_obra: nome_obra.trim(),
          responsaveis: responsaveisTratados,
          ativa: ativa !== undefined ? Boolean(ativa) : true,
        },
      ], { onConflict: 'obra_id' })
      .select()
      .single();

    if (error) {
      console.error('[API] Erro ao salvar obra:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`[API] Obra configurada: "${nome_obra}" (${obra_id})`);
    return res.status(201).json(data);
  } catch (err) {
    console.error('[API] Exceção em POST /api/obras:', err);
    return res.status(500).json({ error: 'Erro interno ao salvar obra.' });
  }
});

// 4. DELETE /api/obras/:id: Remove ou inativa a obra
app.delete('/api/obras/:id', async (req: Request, res: Response) => {
  try {
    const obraId = req.params.id;
    if (!obraId) {
      return res.status(400).json({ error: 'ID da obra inválido.' });
    }

    const { error } = await supabase
      .from('obras_config')
      .delete()
      .eq('obra_id', obraId);

    if (error) {
      console.error(`[API] Erro ao deletar obra ${obraId}:`, error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`[API] Obra removida com sucesso: ${obraId}`);
    return res.json({ success: true, message: 'Obra removida com sucesso.' });
  } catch (err) {
    console.error('[API] Exceção em DELETE /api/obras:', err);
    return res.status(500).json({ error: 'Erro interno ao deletar obra.' });
  }
});

// ==============================================================================
// MÓDULO 3: Frontend do Dashboard (Split View com Grupos & Obras Monitorizadas)
// ==============================================================================
app.get('/', (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GADAP Hub - Gestão Multi-Obras WhatsApp</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .fade-in { animation: fadeIn 0.25s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col items-center py-8 px-4 sm:px-6">

  <!-- Header -->
  <header class="w-full max-w-7xl flex items-center justify-between pb-6 border-b border-slate-800">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
        G
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          GADAP Hub
          <span class="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Multi-Obras</span>
        </h1>
        <p class="text-xs text-slate-400">Painel de Controle e Onboarding WhatsApp</p>
      </div>
    </div>
    <div id="badge-status" class="px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-slate-800 text-slate-400 border border-slate-700">
      <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
      <span id="badge-texto">Carregando...</span>
    </div>
  </header>

  <!-- Container Principal -->
  <main class="w-full max-w-7xl mt-8 flex-1 flex flex-col">

    <!-- Card: Estado Desconectado -->
    <section id="card-desconectado" class="w-full max-w-md mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl fade-in hidden">
      <div class="w-14 h-14 bg-slate-800 rounded-2xl mx-auto flex items-center justify-center mb-4">
        <svg class="w-7 h-7 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
      </div>
      <h2 class="text-lg font-semibold text-white">Conectando ao WhatsApp</h2>
      <p class="text-xs text-slate-400 mt-2">Verificando sessão remota no Supabase...</p>
    </section>

    <!-- Card: Exibição do QR Code -->
    <section id="card-qr" class="w-full max-w-md mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl fade-in hidden">
      <span class="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
        Autenticação Pendente
      </span>
      <h2 class="text-xl font-bold text-white mt-4">Escaneie o QR Code</h2>
      <p class="text-xs text-slate-400 mt-1 mb-6">WhatsApp &gt; Aparelhos Conectados &gt; Conectar um Aparelho</p>
      
      <div class="p-3 bg-white rounded-2xl shadow-inner inline-block mx-auto border-4 border-slate-800">
        <img id="qr-img" class="w-64 h-64 rounded-lg block" src="" alt="QR Code WhatsApp" />
      </div>

      <p class="text-xs text-slate-500 mt-6 flex items-center justify-center gap-1.5">
        <svg class="w-4 h-4 text-emerald-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        O QR Code atualiza dinamicamente
      </p>
    </section>

    <!-- Split View: Grupos Disponíveis (Esq) vs Obras Monitorizadas (Dir) -->
    <section id="card-conectado" class="w-full grid grid-cols-1 lg:grid-cols-2 gap-8 fade-in hidden">
      
      <!-- Painel Esquerdo: Grupos Disponíveis no WhatsApp -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col">
        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              Grupos Disponíveis no WhatsApp
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Grupos detectados na conta do WhatsApp conectada</p>
          </div>
          <span id="grupos-count" class="text-xs font-semibold px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg border border-slate-700">
            0 grupos
          </span>
        </div>

        <div class="mt-4 flex-1 overflow-y-auto max-h-[560px] pr-1 space-y-3" id="grupos-container">
          <!-- Renderizado dinamicamente -->
        </div>
      </div>

      <!-- Painel Direito: Obras Monitorizadas (Configuradas no Banco) -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col">
        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-md shadow-blue-500/50"></span>
              Obras Monitorizadas (Supabase)
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Obras ativas que o bot escuta e dispara relatórios</p>
          </div>
          <span id="obras-count" class="text-xs font-semibold px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/30">
            0 ativas
          </span>
        </div>

        <div class="mt-4 flex-1 overflow-y-auto max-h-[560px] pr-1 space-y-3" id="obras-container">
          <!-- Renderizado dinamicamente -->
        </div>
      </div>

    </section>

  </main>

  <!-- Modal de Configuração de Obra -->
  <div id="modal-obra" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm hidden p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl fade-in">
      <div class="flex items-center justify-between pb-4 border-b border-slate-800">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
          </svg>
          Configurar Monitoramento da Obra
        </h3>
        <button onclick="fecharModal()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800">
          ✕
        </button>
      </div>

      <form id="form-obra" onsubmit="salvarObra(event)" class="mt-5 space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Nome da Obra</label>
          <input type="text" id="modal-nome" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-sans" placeholder="Ex: Residencial Jardins - Bloco B" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">ID do Grupo WhatsApp (JID)</label>
          <input type="text" id="modal-id" readonly class="w-full bg-slate-950/60 border border-slate-800/80 rounded-xl px-3.5 py-2 text-xs font-mono text-emerald-400 select-all cursor-not-allowed" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">
            Telefones dos Responsáveis (Recebedores de Relatórios)
          </label>
          <textarea id="modal-responsaveis" rows="3" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500 font-mono" placeholder="Digite os números com DDI + DDD separados por vírgula. Ex: 5511999998888, 5511988887777"></textarea>
          <p class="text-[11px] text-slate-500 mt-1">O bot enviará os resumos semanais e diários no grupo da obra e também para estes números privados.</p>
        </div>

        <div class="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="fecharModal()" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 transition">
            Cancelar
          </button>
          <button type="submit" id="modal-btn-submit" class="px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition">
            Salvar Obra
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- Toast de Notificação -->
  <div id="toast" class="fixed bottom-6 right-6 bg-slate-900 border border-slate-700 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-2 transition-all duration-300 transform translate-y-20 opacity-0 pointer-events-none z-50">
    <span id="toast-icon">✨</span>
    <span id="toast-msg">Notificação</span>
  </div>

  <footer class="mt-12 text-xs text-slate-600 text-center">
    GADAP Hub • Multi-Project Autonomous Construction Intelligence
  </footer>

  <script>
    let currentStatus = null;
    let cacheObras = [];
    let cacheGrupos = [];

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
      
      // Se a obra já tiver responsáveis cadastrados, preenche
      const existente = cacheObras.find(o => o.obra_id === id);
      document.getElementById('modal-responsaveis').value = existente?.responsaveis ? existente.responsaveis.join(', ') : '';

      document.getElementById('modal-obra').classList.remove('hidden');
    }

    function fecharModal() {
      document.getElementById('modal-obra').classList.add('hidden');
    }

    async function salvarObra(e) {
      e.preventDefault();
      const obra_id = document.getElementById('modal-id').value;
      const nome_obra = document.getElementById('modal-nome').value;
      const responsaveisRaw = document.getElementById('modal-responsaveis').value;
      const responsaveis = responsaveisRaw.split(',').map(s => s.trim()).filter(Boolean);

      try {
        const res = await fetch('/api/obras', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obra_id, nome_obra, responsaveis, ativa: true })
        });

        if (res.ok) {
          fecharModal();
          showToast('Obra "' + nome_obra + '" salva no Supabase!', '✅');
          await carregarObras();
          renderGrupos();
        } else {
          const err = await res.json();
          alert('Erro ao salvar obra: ' + (err.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('Erro de conexão ao salvar obra.');
      }
    }

    async function removerObra(obraId, nome) {
      if (!confirm('Deseja desativar o monitoramento da obra "' + nome + '"?')) return;

      try {
        const res = await fetch('/api/obras/' + encodeURIComponent(obraId), { method: 'DELETE' });
        if (res.ok) {
          showToast('Obra removida com sucesso.', '🗑️');
          await carregarObras();
          renderGrupos();
        }
      } catch (err) {
        alert('Erro ao remover obra.');
      }
    }

    async function carregarObras() {
      try {
        const res = await fetch('/api/obras');
        cacheObras = await res.json();
        renderObras();
      } catch (err) {
        console.error('Erro ao carregar obras:', err);
      }
    }

    function renderObras() {
      const container = document.getElementById('obras-container');
      const count = document.getElementById('obras-count');
      count.innerText = cacheObras.length + ' monitoradas';

      if (cacheObras.length === 0) {
        container.innerHTML = \`
          <div class="py-12 text-center text-slate-500 text-xs border border-dashed border-slate-800 rounded-xl p-6">
            Nenhuma obra configurada ainda.<br/>Selecione um grupo no painel esquerdo e clique em "Configurar Obra".
          </div>
        \`;
        return;
      }

      container.innerHTML = cacheObras.map(o => \`
        <div class="bg-slate-950/80 border border-slate-800/80 hover:border-blue-500/40 rounded-xl p-4 transition-all flex flex-col gap-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h4 class="font-bold text-white text-sm">\${o.nome_obra}</h4>
              <p class="text-[11px] font-mono text-emerald-400 select-all mt-0.5">\${o.obra_id}</p>
            </div>
            <button onclick="removerObra('\${o.obra_id}', '\${o.nome_obra}')" class="text-xs px-2.5 py-1 text-rose-400 hover:bg-rose-500/10 rounded-lg border border-rose-500/20 transition">
              Remover
            </button>
          </div>
          <div class="text-xs text-slate-400 flex items-center gap-2 pt-2 border-t border-slate-800/60">
            <span class="text-[11px] text-slate-500">Responsáveis:</span>
            <div class="flex flex-wrap gap-1">
              \${o.responsaveis && o.responsaveis.length > 0 
                ? o.responsaveis.map(r => \`<span class="px-2 py-0.5 rounded bg-slate-800 text-[11px] font-mono text-slate-300">\${r}</span>\`).join('')
                : '<span class="text-slate-600 text-[11px]">Apenas no grupo</span>'
              }
            </div>
          </div>
        </div>
      \`).join('');
    }

    function renderGrupos() {
      const container = document.getElementById('grupos-container');
      const count = document.getElementById('grupos-count');
      count.innerText = cacheGrupos.length + ' grupos';

      if (cacheGrupos.length === 0) {
        container.innerHTML = '<div class="py-10 text-center text-slate-500 text-xs">Nenhum grupo encontrado nesta conta.</div>';
        return;
      }

      container.innerHTML = cacheGrupos.map(g => {
        const jaConfigurada = cacheObras.some(o => o.obra_id === g.id);
        return \`
          <div class="bg-slate-950/70 border \${jaConfigurada ? 'border-emerald-500/30 bg-emerald-950/10' : 'border-slate-800'} rounded-xl p-3.5 flex items-center justify-between gap-3 hover:border-slate-700 transition">
            <div class="overflow-hidden">
              <div class="flex items-center gap-2">
                <p class="font-medium text-white text-xs truncate">\${g.subject}</p>
                \${jaConfigurada ? '<span class="px-1.5 py-0.2 bg-emerald-500/20 text-emerald-400 text-[9px] rounded font-semibold uppercase">Ativa</span>' : ''}
              </div>
              <p class="text-[11px] font-mono text-slate-500 truncate mt-0.5">\${g.id}</p>
            </div>
            <button onclick="abrirModal('\${g.id}', '\${g.subject}')" class="px-3 py-1.5 rounded-lg \${jaConfigurada ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'} font-semibold text-xs whitespace-nowrap transition">
              \${jaConfigurada ? 'Editar' : 'Configurar Obra'}
            </button>
          </div>
        \`;
      }).join('');
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

          if (data.qrCodeImage) {
            qrImg.src = data.qrCodeImage;
          }
        } else if (data.status === 'conectado') {
          badge.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>WhatsApp Conectado</span>';

          cardDesconectado.classList.add('hidden');
          cardQr.classList.add('hidden');
          cardConectado.classList.remove('hidden');

          cacheGrupos = data.gruposLista || [];
          if (currentStatus !== 'conectado') {
            await carregarObras();
          }
          renderGrupos();
        }

        currentStatus = data.status;
      } catch (err) {
        console.error('Erro em pollStatus:', err);
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
  console.log('🚀 [GADAP Hub] Setup UI & Multi-Obras Manager Online!');
  console.log(`🌐 Acesse no navegador: http://localhost:${PORT}`);
  console.log('======================================================\n');
  iniciarBaileysSetup();
});
