import express, { Request, Response } from 'express';
import makeWASocket, { DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import dotenv from 'dotenv';
import { useSupabaseAuthState } from './lib/useSupabaseAuthState';

dotenv.config();

// ==============================================================================
// Estado Global em Memória
// ==============================================================================
type StatusConexao = 'desconectado' | 'qr' | 'conectado';

interface GrupoInfo {
  id: string;
  subject: string;
  participantsCount?: number;
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
        console.log('[Setup UI] Novo QR Code gerado para exibição visual.');
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
        console.log('[Setup UI] Tentando reconectar em 3 segundos...');
        setTimeout(() => {
          iniciarBaileysSetup();
        }, 3000);
      } else {
        status = 'desconectado';
        console.error('[Setup UI] Desconectado permanentemente (loggedOut). Novo QR Code necessário.');
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
    gruposLista,
  });
});

// ==============================================================================
// Dashboard Embutido (Frontend Moderno Tailwind CSS)
// ==============================================================================
app.get('/', (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GADAP Hub - Onboarding & Setup WhatsApp</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .fade-in { animation: fadeIn 0.3s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col items-center py-10 px-4">

  <!-- Header -->
  <header class="w-full max-w-4xl flex items-center justify-between pb-8 border-b border-slate-800">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
        G
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white">GADAP Hub</h1>
        <p class="text-xs text-slate-400">Setup & Pareamento do Bot de WhatsApp</p>
      </div>
    </div>
    <div id="badge-status" class="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-slate-800 text-slate-400 border border-slate-700">
      <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
      <span id="badge-texto">Carregando...</span>
    </div>
  </header>

  <!-- Container Principal -->
  <main class="w-full max-w-4xl mt-8 flex-1 flex flex-col items-center">

    <!-- Card 1: Estado Desconectado / Inicializando -->
    <section id="card-desconectado" class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl fade-in hidden">
      <div class="w-16 h-16 bg-slate-800 rounded-2xl mx-auto flex items-center justify-center mb-4">
        <svg class="w-8 h-8 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
      </div>
      <h2 class="text-lg font-semibold text-white">Inicializando Conexão</h2>
      <p class="text-sm text-slate-400 mt-2">Conectando ao Supabase e verificando credenciais criptográficas existentes...</p>
    </section>

    <!-- Card 2: Exibição do QR Code -->
    <section id="card-qr" class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center shadow-2xl fade-in hidden">
      <span class="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
        Autenticação Pendente
      </span>
      <h2 class="text-xl font-bold text-white mt-4">Escaneie o QR Code</h2>
      <p class="text-xs text-slate-400 mt-1 mb-6">Abra o WhatsApp no celular &gt; Aparelhos Conectados &gt; Conectar um Aparelho</p>
      
      <div class="p-3 bg-white rounded-2xl shadow-inner inline-block mx-auto border-4 border-slate-800">
        <img id="qr-img" class="w-64 h-64 rounded-lg block" src="" alt="QR Code WhatsApp" />
      </div>

      <p class="text-xs text-slate-500 mt-6 flex items-center justify-center gap-1.5">
        <svg class="w-4 h-4 text-emerald-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        O QR Code atualiza automaticamente
      </p>
    </section>

    <!-- Card 3: Conectado e Lista de Grupos -->
    <section id="card-conectado" class="w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl fade-in hidden">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-6 border-b border-slate-800 gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/50"></span>
            <h2 class="text-lg font-bold text-white">Sessão Conectada com Sucesso!</h2>
          </div>
          <p class="text-xs text-slate-400 mt-1">
            As credenciais foram salvas no Supabase. Copie o ID do grupo da obra abaixo e configure na secret <code class="text-emerald-400 bg-slate-950 px-1.5 py-0.5 rounded">OBRA_GROUP_ID</code> no GitHub.
          </p>
        </div>
        <div class="text-right">
          <span id="grupos-count" class="text-xs font-semibold px-3 py-1 bg-slate-800 text-slate-300 rounded-lg border border-slate-700">
            0 grupos encontrados
          </span>
        </div>
      </div>

      <!-- Tabela de Grupos -->
      <div class="mt-6 overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="text-xs uppercase bg-slate-950/60 text-slate-400 border-b border-slate-800">
            <tr>
              <th scope="col" class="py-3 px-4 rounded-l-lg">Nome da Obra / Grupo</th>
              <th scope="col" class="py-3 px-4">Participantes</th>
              <th scope="col" class="py-3 px-4">Group ID (JID)</th>
              <th scope="col" class="py-3 px-4 text-right rounded-r-lg">Ação</th>
            </tr>
          </thead>
          <tbody id="grupos-tbody" class="divide-y divide-slate-800/60 font-mono text-xs">
            <!-- Renderizado via JavaScript -->
          </tbody>
        </table>
      </div>
    </section>

  </main>

  <!-- Notificação Toast -->
  <div id="toast" class="fixed bottom-6 right-6 bg-emerald-600 text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-xl shadow-emerald-950/50 flex items-center space-x-2 transition-all duration-300 transform translate-y-20 opacity-0 pointer-events-none">
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
    </svg>
    <span id="toast-msg">Copiado com sucesso!</span>
  </div>

  <footer class="mt-12 text-xs text-slate-600 text-center">
    GADAP Hub • WhatsApp Automation Suite for Construction Management
  </footer>

  <script>
    let currentStatus = null;

    function showToast(msg) {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toast-msg');
      toastMsg.innerText = msg;
      toast.classList.remove('translate-y-20', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
      setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
        toast.classList.remove('translate-y-0', 'opacity-100');
      }, 2500);
    }

    function copiarId(id) {
      navigator.clipboard.writeText(id).then(() => {
        showToast('ID copiado: ' + id);
      }).catch(err => {
        console.error('Falha ao copiar:', err);
      });
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        const badge = document.getElementById('badge-status');
        const badgeTexto = document.getElementById('badge-texto');
        const cardDesconectado = document.getElementById('card-desconectado');
        const cardQr = document.getElementById('card-qr');
        const cardConectado = document.getElementById('card-conectado');
        const qrImg = document.getElementById('qr-img');
        const tbody = document.getElementById('grupos-tbody');
        const gruposCount = document.getElementById('grupos-count');

        if (data.status === 'desconectado') {
          badge.className = 'px-3 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-amber-500/10 text-amber-400 border border-amber-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span><span>Conectando...</span>';

          cardDesconectado.classList.remove('hidden');
          cardQr.classList.add('hidden');
          cardConectado.classList.add('hidden');
        } else if (data.status === 'qr') {
          badge.className = 'px-3 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-blue-500/10 text-blue-400 border border-blue-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span><span>Aguardando Scan</span>';

          cardDesconectado.classList.add('hidden');
          cardQr.classList.remove('hidden');
          cardConectado.classList.add('hidden');

          if (data.qrCodeImage) {
            qrImg.src = data.qrCodeImage;
          }
        } else if (data.status === 'conectado') {
          badge.className = 'px-3 py-1.5 rounded-full text-xs font-semibold flex items-center space-x-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
          badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>Conectado</span>';

          cardDesconectado.classList.add('hidden');
          cardQr.classList.add('hidden');
          cardConectado.classList.remove('hidden');

          gruposCount.innerText = data.gruposLista.length + ' grupos encontrados';

          if (currentStatus !== 'conectado' || tbody.children.length === 0) {
            tbody.innerHTML = '';
            if (data.gruposLista.length === 0) {
              tbody.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-slate-500">Nenhum grupo encontrado nesta conta de WhatsApp.</td></tr>';
            } else {
              data.gruposLista.forEach(g => {
                const tr = document.createElement('tr');
                tr.className = 'hover:bg-slate-800/40 transition-colors';
                tr.innerHTML = \`
                  <td class="py-3 px-4 font-sans font-medium text-white">\${g.subject}</td>
                  <td class="py-3 px-4 text-slate-400 font-sans">\${g.participantsCount || '-'} membros</td>
                  <td class="py-3 px-4 text-emerald-400 select-all">\${g.id}</td>
                  <td class="py-3 px-4 text-right">
                    <button onclick="copiarId('\${g.id}')" class="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 font-semibold font-sans text-xs transition-all border border-emerald-500/30">
                      Copiar ID
                    </button>
                  </td>
                \`;
                tbody.appendChild(tr);
              });
            }
          }
        }

        currentStatus = data.status;
      } catch (err) {
        console.error('Erro ao consultar /api/status:', err);
      }
    }

    // Polling a cada 2 segundos
    setInterval(pollStatus, 2000);
    pollStatus();
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
  console.log('🚀 [GADAP Hub] Setup UI & Onboarding WhatsApp Online!');
  console.log(`🌐 Acesse o painel pelo navegador: http://localhost:${PORT}`);
  console.log('======================================================\n');
  iniciarBaileysSetup();
});
