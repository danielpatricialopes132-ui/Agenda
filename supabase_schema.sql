-- ==============================================================================
-- Schema do Supabase para Assistente WhatsApp Serverless / GitHub Actions
-- ==============================================================================

-- 1. Tabela para Auth State remoto do Baileys (substitui arquivos em disco)
CREATE TABLE IF NOT EXISTS public.baileys_auth_state (
    id TEXT PRIMARY KEY,       -- Ex: 'creds', 'app-state-sync-key-...', 'pre-key-...'
    data JSONB NOT NULL,       -- Conteúdo serializado com suporte a Buffer (BufferJSON)
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabela para Deduplicação de Mensagens Processadas
CREATE TABLE IF NOT EXISTS public.mensagens_processadas (
    message_id TEXT PRIMARY KEY,
    remote_jid TEXT NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Tabela de Agendamento da Obra
CREATE TABLE IF NOT EXISTS public.agenda_obra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id TEXT NOT NULL,
    data_evento DATE NOT NULL,
    horario VARCHAR(10) NOT NULL,
    descricao TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Tabela de Log de Disparos Automáticos (Evita envios repetidos na janela do Cron)
CREATE TABLE IF NOT EXISTS public.disparos_executados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_disparo TEXT NOT NULL, -- 'SEMANAL' ou 'DIARIO'
    referencia_data DATE NOT NULL, -- Data do dia do disparo (YYYY-MM-DD)
    disparado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_disparo_tipo_data UNIQUE (tipo_disparo, referencia_data)
);

-- Índices para otimização de consultas
CREATE INDEX IF NOT EXISTS idx_agenda_obra_busca ON public.agenda_obra (obra_id, data_evento, horario);
CREATE INDEX IF NOT EXISTS idx_mensagens_processadas_jid ON public.mensagens_processadas (remote_jid);
