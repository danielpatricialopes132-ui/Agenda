-- Tabela para armazenar os eventos e agendamentos da obra
CREATE TABLE IF NOT EXISTS public.agenda_obra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id TEXT NOT NULL,
    data_evento DATE NOT NULL,
    horario VARCHAR(10) NOT NULL,
    descricao TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para agilizar as consultas de cron e filtros por obra e período
CREATE INDEX IF NOT EXISTS idx_agenda_obra_consulta 
ON public.agenda_obra (obra_id, data_evento, horario);

