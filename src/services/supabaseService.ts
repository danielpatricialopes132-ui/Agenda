import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';

/**
 * Cliente configurado do Supabase para operações no banco de dados.
 */
export const supabase = createClient(config.supabaseUrl, config.supabaseKey);

export interface AgendaObra {
  id?: string;
  obra_id: string;
  data_evento: string; // formato YYYY-MM-DD
  horario: string;     // formato HH:MM
  descricao: string;
  created_at?: string;
}

/**
 * Salva um novo evento/agendamento de obra na tabela agenda_obra.
 */
export async function salvarAgendamento(evento: Omit<AgendaObra, 'id' | 'created_at'>): Promise<AgendaObra | null> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .insert([
      {
        obra_id: evento.obra_id,
        data_evento: evento.data_evento,
        horario: evento.horario,
        descricao: evento.descricao,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('Erro ao salvar agendamento no Supabase:', error.message);
    return null;
  }

  return data;
}

/**
 * Busca eventos de uma obra entre um intervalo de datas.
 */
export async function buscarEventosPorIntervalo(
  obraId: string,
  dataInicio: string,
  dataFim: string
): Promise<AgendaObra[]> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .select('*')
    .eq('obra_id', obraId)
    .gte('data_evento', dataInicio)
    .lte('data_evento', dataFim)
    .order('data_evento', { ascending: true })
    .order('horario', { ascending: true });

  if (error) {
    console.error('Erro ao consultar eventos no Supabase:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Busca eventos do dia exato para uma obra.
 */
export async function buscarEventosDoDia(obraId: string, dataIso: string): Promise<AgendaObra[]> {
  const { data, error } = await supabase
    .from('agenda_obra')
    .select('*')
    .eq('obra_id', obraId)
    .eq('data_evento', dataIso)
    .order('horario', { ascending: true });

  if (error) {
    console.error('Erro ao consultar eventos do dia no Supabase:', error.message);
    return [];
  }

  return data || [];
}

