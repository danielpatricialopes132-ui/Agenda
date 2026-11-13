import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('FATAL: SUPABASE_URL e SUPABASE_KEY são obrigatórios para o Baileys Auth State.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Cache em memória durante o ciclo de execução efêmero para minimizar
 * chamadas repetidas de leitura/escrita ao Supabase.
 */
const inMemoryCache = new Map<string, any>();

/**
 * Lê uma chave criptográfica do cache em memória ou do Supabase.
 */
async function readData(key: string): Promise<any | null> {
  if (inMemoryCache.has(key)) {
    return inMemoryCache.get(key);
  }

  const { data, error } = await supabase
    .from('baileys_auth_state')
    .select('data')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error(`[AuthState] Erro ao ler chave "${key}":`, error.message);
    return null;
  }

  if (!data || !data.data) {
    return null;
  }

  try {
    const parsed = JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
    inMemoryCache.set(key, parsed);
    return parsed;
  } catch (err) {
    console.error(`[AuthState] Erro ao deserializar chave "${key}":`, err);
    return null;
  }
}

/**
 * Grava ou remove uma chave criptográfica no cache em memória e no Supabase.
 */
async function writeData(key: string, value: any): Promise<void> {
  if (value === null || value === undefined) {
    inMemoryCache.delete(key);
    const { error } = await supabase
      .from('baileys_auth_state')
      .delete()
      .eq('key', key);

    if (error) {
      console.error(`[AuthState] Erro ao deletar chave "${key}":`, error.message);
    }
    return;
  }

  inMemoryCache.set(key, value);
  try {
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await supabase
      .from('baileys_auth_state')
      .upsert(
        [
          {
            key,
            data: serialized,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: 'key' }
      );

    if (error) {
      console.error(`[AuthState] Erro ao persistir chave "${key}":`, error.message);
    }
  } catch (err) {
    console.error(`[AuthState] Exceção ao serializar chave "${key}":`, err);
  }
}

/**
 * Adaptador completo de Auth State do Baileys persistido no Supabase
 * com suporte a cache em memória e tratamento de tipos binários via BufferJSON.
 */
export async function useSupabaseAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // 1. Carrega ou inicializa as credenciais principais ('creds')
  const existingCreds = await readData('creds');
  const creds: AuthenticationCreds = existingCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[]
        ): Promise<{ [key: string]: SignalDataTypeMap[T] }> => {
          const result: { [key: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const key = `${type}-${id}`;
            const value = await readData(key);
            if (value) {
              result[id] = value;
            }
          }
          return result;
        },
        set: async (data: any): Promise<void> => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(writeData(key, value));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async (): Promise<void> => {
      await writeData('creds', creds);
    },
  };
}
