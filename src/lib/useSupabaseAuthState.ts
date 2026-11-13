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
const supabaseKey =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  '';

if (!supabaseUrl || !supabaseKey) {
  console.error('[Supabase Auth State] FATAL: SUPABASE_URL e SUPABASE_KEY não configurados no ambiente.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Adaptador customizado de autenticação do Baileys persistido no Supabase.
 * Permite que ambientes serverless (GitHub Actions) restaurem e salvem a sessão
 * criptográfica remotamente na tabela `baileys_auth_state`.
 *
 * @param sessionName Nome/identificador do namespace da sessão (ex: 'default', 'obra_principal')
 */
export async function useSupabaseAuthState(sessionName: string = 'default'): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Cache em memória (Map local) para evitar requisições excessivas ao Supabase.
  // O Baileys consulta repetidamente as mesmas chaves de sinal e credenciais por segundo.
  const localCache = new Map<string, any>();

  // Helper para prefixar os IDs com o nome da sessão e isolar sessões distintas
  const buildKey = (id: string): string => `${sessionName}:${id}`;

  /**
   * Lê uma chave do cache em memória ou da tabela baileys_auth_state no Supabase.
   */
  async function readData(id: string): Promise<any | null> {
    const key = buildKey(id);

    if (localCache.has(key)) {
      return localCache.get(key);
    }

    try {
      const { data, error } = await supabase
        .from('baileys_auth_state')
        .select('data')
        .eq('id', key)
        .maybeSingle();

      if (error) {
        console.error(`[DB] Erro ao consultar chave "${key}" no Supabase:`, error.message);
        return null;
      }

      if (!data || !data.data) {
        return null;
      }

      // Converte strings serializadas de volta em Buffers binários nativos do Baileys
      const rawString = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
      const parsed = JSON.parse(rawString, BufferJSON.reviver);

      localCache.set(key, parsed);
      return parsed;
    } catch (err) {
      console.error(`[DB] Exceção ao deserializar chave "${key}":`, err);
      return null;
    }
  }

  /**
   * Grava uma chave no cache em memória e executa UPSERT no Supabase.
   */
  async function writeData(data: any, id: string): Promise<void> {
    const key = buildKey(id);
    localCache.set(key, data);

    try {
      // Serializa com BufferJSON.replacer para converter Buffers binários em JSON seguro
      const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));

      const { error } = await supabase
        .from('baileys_auth_state')
        .upsert(
          [
            {
              id: key,
              data: serialized,
              updated_at: new Date().toISOString(),
            },
          ],
          { onConflict: 'id' }
        );

      if (error) {
        console.error(`[DB] Erro ao realizar UPSERT na chave "${key}":`, error.message);
      }
    } catch (err) {
      console.error(`[DB] Exceção ao serializar/gravar chave "${key}":`, err);
    }
  }

  /**
   * Remove uma chave do cache em memória e do Supabase.
   */
  async function removeData(id: string): Promise<void> {
    const key = buildKey(id);
    localCache.delete(key);

    try {
      const { error } = await supabase
        .from('baileys_auth_state')
        .delete()
        .eq('id', key);

      if (error) {
        console.error(`[DB] Erro ao remover chave "${key}" do Supabase:`, error.message);
      }
    } catch (err) {
      console.error(`[DB] Exceção ao deletar chave "${key}":`, err);
    }
  }

  // 1. Carrega ou inicializa as credenciais principais ('creds')
  const existingCreds = await readData('creds');
  const creds: AuthenticationCreds = existingCreds || initAuthCreds();

  // 2. Monta o AuthenticationState completo esperado pelo Baileys
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ): Promise<{ [key: string]: SignalDataTypeMap[T] }> => {
        const result: { [key: string]: SignalDataTypeMap[T] } = {};

        for (const id of ids) {
          const value = await readData(`${type}-${id}`);
          if (value) {
            result[id] = value;
          }
        }

        return result;
      },
      set: async (data: any): Promise<void> => {
        const operations: Promise<void>[] = [];

        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const internalId = `${category}-${id}`;

            if (value !== null && value !== undefined) {
              operations.push(writeData(value, internalId));
            } else {
              operations.push(removeData(internalId));
            }
          }
        }

        await Promise.all(operations);
      },
    },
  };

  return {
    state,
    saveCreds: async (): Promise<void> => {
      await writeData(creds, 'creds');
    },
  };
}
