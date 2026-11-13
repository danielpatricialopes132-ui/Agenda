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
          console.log(`[Setup UI] ${gruposLista.length} grupos carregados com sucesso!`);
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
// API Endpoints Robustos
// ==============================================================================

// 1. Status da Conexão e Lista de Grupos
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status,
    qrCodeImage,
    gruposLista: Array.isArray(gruposLista) ? gruposLista : [],
  });
});

// 2. GET /api/obras: Garante retorno SEMPRE de array, tratando tabela inexistente
app.get('/api/obras', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('obras_config')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      // Se a tabela ainda não foi criada no Supabase, loga e devolve array vazio com status informativo
      console.warn('[API /api/obras] Aviso na consulta ao Supabase:', error.message);
      return res.json({
        sucesso: false,
        aviso: 'Tabela obras_config ainda não criada no Supabase.',
        obras: [],
      });
    }

    const lista = Array.isArray(data) ? data : [];
    return res.json({
      sucesso: true,
      obras: lista,
    });
  } catch (err: any) {
    console.error('[API /api/obras] Exceção:', err);
    return res.json({
      sucesso: false,
      aviso: 'Erro interno ao consultar obras.',
      obras: [],
    });
  }
});

// 3. POST /api/obras: Criação ou atualização com feedback claro
app.post('/api/obras', async (req: Request, res: Response) => {
  try {
    const { obra_id, nome_obra, responsaveis, ativa } = req.body;

    if (!obra_id || !nome_obra) {
      return res.status(400).json({ error: 'Campos obra_id e nome_obra são obrigatórios.' });
    }

    const responsaveisTratados: string[] = Array.isArray(responsaveis)
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
      console.error('[API] Erro ao salvar obra no Supabase:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`[API] Obra configurada: "${nome_obra}" (${obra_id})`);
    return res.status(201).json({ sucesso: true, obra: data });
  } catch (err: any) {
    console.error('[API] Exceção em POST /api/obras:', err);
    return res.status(500).json({ error: 'Erro interno ao salvar obra.' });
  }
});

// 4. DELETE /api/obras/:id: Remoção de obra
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
    return res.json({ sucesso: true });
  } catch (err: any) {
    console.error('[API] Exceção em DELETE /api/obras:', err);
    return res.status(500).json({ error: 'Erro interno ao deletar obra.' });
  }
});

// ==============================================================================
// Dashboard Embutido (Frontend Reformulado com Injeção Segura e Modal)
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
    .custom-scroll::-webkit-scrollbar { width: 6px; }
    .custom-scroll::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.6); }
    .custom-scroll::-webkit-scrollbar-thumb { background: rgba(51, 65, 85, 0.8); border-radius: 4px; }
    .custom-scroll::-webkit-scrollbar-thumb:hover { background: rgba(71, 85, 105, 1); }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col py-8 px-4 sm:px-6">

  <!-- Header -->
  <header class="w-full max-w-7xl mx-auto flex items-center justify-between pb-6 border-b border-slate-800">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
        G
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          GADAP Hub
          <span class="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Multi-Obras</span>
        </h1>
        <p class="text-xs text-slate-400">Painel de Onboarding & Gestão de Grupos de WhatsApp</p>
      </div>
    </div>
    <div id="badge-status" class="px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-slate-800 text-slate-400 border border-slate-700">
      <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
      <span id="badge-texto">Carregando status...</span>
    </div>
  </header>

  <!-- Container Principal -->
  <main class="w-full max-w-7xl mx-auto mt-6 flex-1 flex flex-col">

    <!-- Alerta: Tabela Supabase Pendente -->
    <div id="alerta-supabase" class="hidden mb-6 bg-amber-950/40 border border-amber-500/40 rounded-2xl p-4 flex items-start gap-3 text-amber-200 text-xs">
      <span class="text-base">⚠️</span>
      <div class="flex-1">
        <p class="font-bold text-amber-100">Atenção: Tabela obras_config ainda não criada no Supabase</p>
        <p class="mt-0.5 text-amber-300/80">
          Abra o SQL Editor do seu Supabase e execute o comando:
          <code class="block mt-1 font-mono bg-slate-950/80 p-2 rounded text-emerald-400 border border-amber-500/20">
            CREATE TABLE IF NOT EXISTS public.obras_config (obra_id TEXT PRIMARY KEY, nome_obra TEXT NOT NULL, responsaveis TEXT[] DEFAULT '{}', ativa BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW());
          </code>
        </p>
      </div>
    </div>

    <!-- Tela 1: Desconectado / Conectando -->
    <section id="card-desconectado" class="w-full max-w-md mx-auto my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl hidden">
      <div class="w-14 h-14 bg-slate-800 rounded-2xl mx-auto flex items-center justify-center mb-4">
        <svg class="w-7 h-7 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
      </div>
      <h2 class="text-lg font-semibold text-white">Conectando ao WhatsApp</h2>
      <p class="text-xs text-slate-400 mt-2">Carregando credenciais criptográficas remotas no Supabase...</p>
    </section>

    <!-- Tela 2: QR Code -->
    <section id="card-qr" class="w-full max-w-md mx-auto my-auto bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl hidden">
      <span class="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
        Autenticação Requerida
      </span>
      <h2 class="text-xl font-bold text-white mt-4">Escaneie o QR Code</h2>
      <p class="text-xs text-slate-400 mt-1 mb-6">WhatsApp no Celular &gt; Aparelhos Conectados &gt; Conectar um Aparelho</p>
      
      <div class="p-3 bg-white rounded-2xl shadow-inner inline-block mx-auto border-4 border-slate-800">
        <img id="qr-img" class="w-64 h-64 rounded-lg block" src="" alt="QR Code WhatsApp" />
      </div>

      <p class="text-xs text-slate-500 mt-6 flex items-center justify-center gap-1.5">
        <svg class="w-4 h-4 text-emerald-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        Atualização automática em tempo real
      </p>
    </section>

    <!-- Tela 3: Split View (Grupos Disponíveis vs Obras Monitorizadas) -->
    <section id="card-conectado" class="w-full grid grid-cols-1 lg:grid-cols-2 gap-8 hidden flex-1">
      
      <!-- Painel Esquerdo: Grupos Disponíveis no WhatsApp -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col h-[650px]">
        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50"></span>
              Grupos Disponíveis no WhatsApp
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Grupos identificados na conta conectada</p>
          </div>
          <span id="grupos-count" class="text-xs font-semibold px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg border border-slate-700">
            0 grupos
          </span>
        </div>

        <!-- Lista Dinâmica de Grupos -->
        <ul id="grupos-lista" class="mt-4 flex-1 overflow-y-auto custom-scroll pr-1 space-y-2.5">
          <li class="py-12 text-center text-slate-500 text-xs">Carregando grupos do WhatsApp...</li>
        </ul>
      </div>

      <!-- Painel Direito: Obras Monitorizadas (Configuradas no Banco) -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col h-[650px]">
        <div class="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-md shadow-blue-500/50"></span>
              Obras Monitorizadas (Supabase)
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Obras ativas que o bot lê agendamentos e envia relatórios</p>
          </div>
          <span id="obras-count" class="text-xs font-semibold px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/30">
            0 monitoradas
          </span>
        </div>

        <!-- Lista Dinâmica de Obras -->
        <ul id="obras-lista" class="mt-4 flex-1 overflow-y-auto custom-scroll pr-1 space-y-2.5">
          <li class="py-12 text-center text-slate-500 text-xs">Carregando obras do Supabase...</li>
        </ul>
      </div>

    </section>

  </main>

  <!-- Modal de Configuração de Obra -->
  <div id="modal-obra" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm hidden p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
      <div class="flex items-center justify-between pb-4 border-b border-slate-800">
        <h3 class="text-base font-bold text-white flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-blue-500"></span>
          Configurar Monitoramento da Obra
        </h3>
        <button onclick="fecharModal()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 text-sm">
          ✕
        </button>
      </div>

      <form id="form-obra" onsubmit="salvarObra(event)" class="mt-5 space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Nome da Obra</label>
          <input type="text" id="modal-nome" required class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-sans" placeholder="Ex: Edifício Bella Vista" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">ID do Grupo WhatsApp (JID)</label>
          <input type="text" id="modal-id" readonly class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-xs font-mono text-emerald-400 select-all cursor-not-allowed" />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">
            Números dos Responsáveis (Separados por vírgula)
          </label>
          <textarea id="modal-responsaveis" rows="3" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500 font-mono" placeholder="5511999998888, 5511988887777"></textarea>
          <p class="text-[11px] text-slate-500 mt-1">Os números receberão os relatórios semanais e diários diretamente no WhatsApp privado.</p>
        </div>

        <div class="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="fecharModal()" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 transition">
            Cancelar
          </button>
          <button type="submit" id="btn-salvar" class="px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition">
            Salvar Obra
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-6 right-6 bg-slate-900 border border-slate-700 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-2 transition-all duration-300 transform translate-y-20 opacity-0 pointer-events-none z-50">
    <span id="toast-icon">✨</span>
    <span id="toast-msg">Mensagem</span>
  </div>

  <footer class="mt-8 text-xs text-slate-600 text-center">
    GADAP Hub • Multi-Project WhatsApp Automation Suite
  </footer>

  <script>
    let cacheGrupos = [];
    let cacheObras = [];

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

      const obraExistente = cacheObras.find(o => o.obra_id === id);
      document.getElementById('modal-responsaveis').value = obraExistente?.responsaveis ? obraExistente.responsaveis.join(', ') : '';

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
      const responsaveisRaw = document.getElementById('modal-responsaveis').value;
      const responsaveis = responsaveisRaw.split(',').map(s => s.trim()).filter(Boolean);

      try {
        const res = await fetch('/api/obras', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ obra_id, nome_obra, responsaveis, ativa: true })
        });

        const json = await res.json();
        if (res.ok && json.sucesso) {
          fecharModal();
          showToast('Obra configurada com sucesso!', '✅');
          await carregarObras();
          renderGrupos();
        } else {
          alert('Erro ao salvar obra: ' + (json.error || 'Erro desconhecido. Verifique se a tabela obras_config foi criada no Supabase.'));
        }
      } catch (err) {
        alert('Erro de conexão ao salvar obra.');
      } finally {
        btn.innerText = 'Salvar Obra';
        btn.disabled = false;
      }
    }

    async function removerObra(obraId, nome) {
      if (!confirm('Deseja realmente remover o monitoramento da obra "' + nome + '"?')) return;

      try {
        const res = await fetch('/api/obras/' + encodeURIComponent(obraId), { method: 'DELETE' });
        if (res.ok) {
          showToast('Obra removida.', '🗑️');
          await carregarObras();
          renderGrupos();
        }
      } catch (err) {
        alert('Erro de conexão ao remover obra.');
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
        const obraExistente = cacheObras.find(o => o.obra_id === g.id);
        const jaConfigurada = !!obraExistente;
        const nomeExibicao = jaConfigurada ? obraExistente.nome_obra : g.subject;

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

      const obras = Array.isArray(cacheObras) ? cacheObras : [];
      countEl.innerText = obras.length + ' monitoradas';

      if (obras.length === 0) {
        listaEl.innerHTML = \`
          <li class="py-12 text-center text-slate-500 text-xs border border-dashed border-slate-800/80 rounded-xl p-6">
            Nenhuma obra monitorizada ainda.<br/>Selecione um grupo no painel esquerdo e clique em "Configurar".
          </li>
        \`;
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
        
        const alertaEl = document.getElementById('alerta-supabase');
        if (json.sucesso === false && json.aviso) {
          alertaEl.classList.remove('hidden');
        } else {
          alertaEl.classList.add('hidden');
        }

        cacheObras = Array.isArray(json.obras) ? json.obras : [];
        renderObras();
      } catch (err) {
        console.error('Erro ao consultar /api/obras:', err);
        cacheObras = [];
        renderObras();
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

          if (data.qrCodeImage) {
            qrImg.src = data.qrCodeImage;
          }
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
        console.error('Erro em pollStatus:', err);
      }
    }

    // Inicialização
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
