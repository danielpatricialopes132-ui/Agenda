-- ==============================================================================
-- Schema Supabase para o ecossistema GADAP Hub - Bot Multi-Obras
-- ==============================================================================

-- 1. Tabela de Configuração e Monitoramento de Múltiplas Obras
CREATE TABLE IF NOT EXISTS public.obras_config (
    obra_id TEXT PRIMARY KEY,               -- O ID do grupo do WhatsApp (ex: '12036302XXXXXXXXXX@g.us')
    nome_obra TEXT NOT NULL,                -- Nome identificador da obra
    responsaveis TEXT[] DEFAULT '{}',       -- Lista de telefones responsáveis (ex: ['5511999999999'])
    ativa BOOLEAN DEFAULT TRUE,             -- Flag para ativar/desativar monitoramento da obra
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabela de Estado de Autenticação Remota do Baileys
CREATE TABLE IF NOT EXISTS public.baileys_auth_state (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Tabela de Deduplicação de Mensagens Processadas
CREATE TABLE IF NOT EXISTS public.mensagens_processadas (
    message_id TEXT PRIMARY KEY,
    remote_jid TEXT NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Tabela de Agendamento da Obra
CREATE TABLE IF NOT EXISTS public.agenda_obra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id TEXT NOT NULL REFERENCES public.obras_config(obra_id) ON DELETE CASCADE,
    data_evento DATE NOT NULL,
    horario VARCHAR(10) NOT NULL,
    descricao TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Tabela de Controle de Disparos de Relatórios Multi-Obras
CREATE TABLE IF NOT EXISTS public.disparos_executados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id TEXT NOT NULL,
    tipo_disparo TEXT NOT NULL, -- 'SEMANAL' ou 'DIARIO'
    referencia_data DATE NOT NULL,
    disparado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_disparo_obra_tipo_data UNIQUE (obra_id, tipo_disparo, referencia_data)
);

-- Índices para otimização de consultas
CREATE INDEX IF NOT EXISTS idx_obras_config_ativa ON public.obras_config (ativa);
CREATE INDEX IF NOT EXISTS idx_agenda_obra_busca ON public.agenda_obra (obra_id, data_evento, horario);
CREATE INDEX IF NOT EXISTS idx_mensagens_processadas_jid ON public.mensagens_processadas (remote_jid);
