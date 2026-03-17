
import Fuse from 'fuse.js';
import { GoogleGenAI, Type } from "@google/genai";
import { AddressResult } from "./types";

const MODEL_NAME = "gemini-3-flash-preview";

export class GeminiService {
  private fuse: Fuse<string> | null = null;
  private lastOfficialStreets: string[] = [];

  private async delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private normalize(text: string): string {
    return text.toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\bR\b\.?/g, 'RUA')
      .replace(/\bAV\b\.?/g, 'AVENIDA')
      .replace(/\bTV\b\.?/g, 'TRAVESSA')
      .replace(/\bPC\b\.?/g, 'PRACA')
      .replace(/\bAL\b\.?/g, 'ALAMEDA')
      .replace(/\bEST\b\.?/g, 'ESTRADA')
      .replace(/\bROD\b\.?/g, 'RODOVIA')
      .replace(/\bVLA\b\.?/g, 'VILA')
      .replace(/\bLGO\b\.?/g, 'LARGO')
      .replace(/\bSTO\b\.?/g, 'SANTO')
      .replace(/\bSTA\b\.?/g, 'SANTA')
      .replace(/\bS\/N\b/g, 'SN')
      .replace(/[,.-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getRelevantStreets(messyAddresses: string[], officialStreets: string[]): string[] {
    if (officialStreets.length === 0) return [];

    // Inicializa ou atualiza o cache do Fuse para evitar reprocessamento pesado
    if (!this.fuse || this.lastOfficialStreets !== officialStreets) {
      this.fuse = new Fuse(officialStreets, {
        threshold: 0.3, // Um pouco mais rigoroso para compensar o limite menor
        distance: 100,
        ignoreLocation: true,
        minMatchCharLength: 3
      });
      this.lastOfficialStreets = officialStreets;
    }

    const relevantSet = new Set<string>();
    
    // 1. Busca Fuzzy por endereço (limpa ruídos como números e complementos)
    messyAddresses.forEach(addr => {
      const searchTerms = this.normalize(addr)
        .replace(/\d+/g, '')
        .replace(/\b(APTO|CASA|BLOCO|FUNDOS|LOJA|SALA|KM|QD|LT|ANDAR|UNIDADE|NIVEL|PAVIMENTO|SALAO|BOX|S\/N|SN)\b.*/g, '');

      if (searchTerms.length > 3) {
        // Aumentamos o limite por endereço para garantir que as melhores opções entrem no set
        const results = this.fuse!.search(searchTerms, { limit: 10 });
        results.forEach(r => relevantSet.add(r.item));
      }
    });

    // 2. Fallback por Palavras-Chave (captura variações que o fuzzy pode perder)
    const keywords = new Set<string>();
    messyAddresses.forEach(addr => {
      const normalized = this.normalize(addr);
      const words = normalized.split(/\s+/)
        .filter(w => w.length > 3 && !['RUA', 'AVENIDA', 'TRAVESSA', 'PRACA', 'ALAMEDA', 'ESTRADA', 'RODOVIA', 'JUIZ', 'FORA', 'MINAS', 'GERAIS'].includes(w));
      words.forEach(w => keywords.add(w));
    });

    if (keywords.size > 0) {
      const kwArray = Array.from(keywords);
      // Busca otimizada: paramos quando atingimos o novo limite de 300
      for (const street of officialStreets) {
        if (relevantSet.size >= 300) break; 
        if (relevantSet.has(street)) continue;

        const streetNorm = this.normalize(street);
        if (kwArray.some(kw => streetNorm.includes(kw))) {
          relevantSet.add(street);
        }
      }
    }

    const result = Array.from(relevantSet);
    // Retorna até 300 ruas para otimizar o prompt sem perder qualidade.
    return result.length > 0 ? result.slice(0, 300) : officialStreets.slice(0, 150);
  }

  async standardizeBatch(
    messyAddresses: string[],
    officialStreets: string[],
    retryCount = 0
  ): Promise<AddressResult[]> {
    const MAX_RETRIES = 3; // Aumentado para 3 tentativas
    // Filtro inteligente: enviar apenas ruas que tenham alguma semelhança com o lote atual
    const relevantStreets = this.getRelevantStreets(messyAddresses, officialStreets);

    const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("API_KEY_MISSING: Nenhuma chave de API encontrada no ambiente.");
    }
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
      Você é um assistente de geoprocessamento ultra-rápido.
      Converta endereços brutos em JSON estruturado usando a BASE DE REFERÊNCIA.
      
      BASE DE REFERÊNCIA (Apenas ruas relevantes):
      ${relevantStreets.join(', ')}

      ENDEREÇOS:
      ${messyAddresses.map((a, idx) => `${idx + 1}. ${a}`).join('\n')}

      RETORNE APENAS UM ARRAY JSON:
      [{ "original": "...", "standardized": "Nome da Rua, Numero", "streetName": "Nome da Rua", "number": "123", "neighborhood": "Bairro", "postalCode": "00000-000", "matchConfidence": 0.9, "isCorrected": true, "latitude": -21.7, "longitude": -43.3 }]
    `;

    try {
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                original: { type: Type.STRING },
                standardized: { type: Type.STRING },
                streetName: { type: Type.STRING },
                number: { type: Type.STRING },
                neighborhood: { type: Type.STRING },
                postalCode: { type: Type.STRING },
                matchConfidence: { type: Type.NUMBER },
                isCorrected: { type: Type.BOOLEAN },
                latitude: { type: Type.NUMBER },
                longitude: { type: Type.NUMBER },
                error: { type: Type.STRING }
              },
              required: ["original", "standardized", "streetName", "number", "neighborhood", "postalCode", "matchConfidence", "isCorrected", "latitude", "longitude"]
            }
          }
        }
      });

      const text = response.text;
      if (!text) throw new Error("EMPTY_RESPONSE");
      
      let results: AddressResult[] = JSON.parse(text);
      return results;
    } catch (error: any) {
      const msg = error.message || "";
      
      // Retry logic for transient errors (429, 500, 503)
      if ((msg.includes("429") || msg.includes("500") || msg.includes("503") || msg.includes("quota")) && retryCount < MAX_RETRIES) {
        // Backoff exponencial mais agressivo: 3s, 6s, 12s
        const waitTime = Math.pow(2, retryCount) * 3000;
        console.log(`Erro de cota ou servidor (${msg}). Tentativa ${retryCount + 1}/${MAX_RETRIES}. Aguardando ${waitTime}ms...`);
        await this.delay(waitTime);
        return this.standardizeBatch(messyAddresses, officialStreets, retryCount + 1);
      }

      if (msg.includes("429") || msg.includes("quota")) {
        console.error("Limite de cota atingido permanentemente para este lote.");
      }
      if (msg.includes("403")) throw new Error("ERRO DE CHAVE: Verifique sua API KEY.");
      
      // If it's the last retry or a non-transient error, return a failed batch result instead of throwing
      // This allows the UI to continue processing other batches
      return messyAddresses.map(addr => ({
        original: addr,
        standardized: addr,
        streetName: "",
        number: "",
        neighborhood: "",
        postalCode: "",
        matchConfidence: 0,
        isCorrected: false,
        latitude: 0,
        longitude: 0,
        error: `Falha no processamento: ${msg}`
      }));
    }
  }
}
