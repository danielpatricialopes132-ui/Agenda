import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  obraGroupId: process.env.OBRA_GROUP_ID || '',
  obraId: process.env.OBRA_ID || 'obra_padrao',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || '',
};

