
export interface AddressResult {
  original: string;
  standardized: string;
  streetName: string;
  number: string;
  neighborhood: string;
  postalCode: string;
  matchConfidence: number; // 0 to 1
  isCorrected: boolean;
  latitude: number;
  longitude: number;
  source?: 'Local' | 'OSM' | 'IBGE' | 'IA' | 'Erro';
  error?: string;
}

export interface GeoJsonFeature {
  type: string;
  properties: Record<string, any>;
  geometry: any;
}

export interface GeoJsonData {
  type: string;
  features: GeoJsonFeature[];
}

export enum AppStatus {
  IDLE = 'IDLE',
  PARSING_FILE = 'PARSING_FILE',
  MAPPING_COLUMNS = 'MAPPING_COLUMNS',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface FileData {
  name: string;
  columns: string[];
  rawRows: Record<string, any>[];
  geometries?: any[]; // Para armazenar coordenadas de GeoJSON
}
