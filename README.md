# Agenda Obra Bot (WhatsApp + Gemini + Supabase + Baileys)

Bot de WhatsApp para gestão autônoma de agendamentos em obras da construção civil.

---

## 🛠️ Configuração Inicial

### 1. Supabase
Execute o script [supabase_schema.sql](file:///c:/Agenda/supabase_schema.sql) no SQL Editor do seu projeto Supabase para criar a tabela `agenda_obra`.

### 2. Variáveis de Ambiente
Copie o `.env.example` para `.env` e preencha:
- `PORT`: Porta do servidor web (ex: `3000` local ou atribuído automaticamente no Render).
- `OBRA_GROUP_ID`: ID do grupo de WhatsApp da obra (ex: `12036302XXXXXXXXXX@g.us`). Se ainda não souber o ID, inicie o bot e mande qualquer mensagem no grupo; o bot imprimirá o ID do grupo no terminal/logs.
- `GEMINI_API_KEY`: Sua chave de API do Google AI Studio.
- `SUPABASE_URL` e `SUPABASE_KEY`: Credenciais do projeto Supabase.

---

## 🚀 Execução Local

```bash
# Instalar dependências
npm install

# Modo desenvolvimento (hot reload)
npm run dev

# Build de produção
npm run build
npm start
```

Ao iniciar, escaneie o **QR Code** impresso no terminal com o WhatsApp do aparelho que atuará como bot. A sessão será salva localmente na pasta `auth_info_baileys/`.

---

## ☁️ Deploy no Render (Web Service)

1. Crie um novo **Web Service** no Render conectando seu repositório:
   `https://github.com/danielpatricialopes132-ui/Agenda.git`
2. Configure:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
3. Em **Environment Variables**, adicione todas as variáveis do `.env`.
4. Nos logs do Render (ou rodando localmente uma primeira vez e sincronizando as credenciais se usar disco persistente), faça a autenticação do WhatsApp.
5. O Express responderá na rota `/` atendendo o health check exigido pelo Render para manter a aplicação online.

