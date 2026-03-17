
import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AppStatus, GeoJsonData, AddressResult, FileData } from './types';
import { GeminiService } from './geminiService';
import * as XLSX from 'xlsx';

// Declarar Leaflet globalmente para o TypeScript
declare const L: any;

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [detailedError, setDetailedError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  
  // Referências do Mapa
  const mapRef = useRef<any>(null);
  const markersLayerRef = useRef<any>(null);

  // Base Oficial
  const [officialFileDatas, setOfficialFileDatas] = useState<(FileData & { selectedCol: string })[]>([]);
  const [officialStreets, setOfficialStreets] = useState<string[]>([]);
  
  // Base de Trabalho
  const [inputMode, setInputMode] = useState<'manual' | 'file'>('manual');
  const [inputFileDatas, setInputFileDatas] = useState<(FileData & { selectedCol: string, type: string })[]>([]);
  const [inputAddresses, setInputAddresses] = useState<string>('');
  
  const [results, setResults] = useState<AddressResult[]>([]);
  const geminiService = useRef(new GeminiService());

  // Processing Stats
  const [startTime, setStartTime] = useState<number | null>(null);
  const [estimatedTime, setEstimatedTime] = useState<string | null>(null);

  // Onboarding State
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  useEffect(() => {
    const hasSeenOnboarding = localStorage.getItem('hasSeenOnboarding');
    if (!hasSeenOnboarding) {
      setShowOnboarding(true);
    }
  }, []);

  const closeOnboarding = () => {
    setShowOnboarding(false);
    localStorage.setItem('hasSeenOnboarding', 'true');
  };

  // Inicializar Mapa e Atualizar Marcadores
  useEffect(() => {
    if (!mapRef.current) {
      const mapContainer = document.getElementById('map');
      if (mapContainer) {
        mapRef.current = L.map('map').setView([-21.7642, -43.3503], 13);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
          attribution: '©OpenStreetMap contributors'
        }).addTo(mapRef.current);
        markersLayerRef.current = L.markerClusterGroup({
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          spiderfyOnMaxZoom: true,
          maxClusterRadius: 50
        }).addTo(mapRef.current);
      }
    }
  }, []);

  useEffect(() => {
    if (mapRef.current) {
      updateMapMarkers();
    }
  }, [results]);

  useEffect(() => {
    if (viewMode === 'map' && mapRef.current) {
      setTimeout(() => {
        mapRef.current.invalidateSize();
        // Re-fit bounds if there are results
        if (results.length > 0) {
          const bounds = L.latLngBounds(results
            .filter(r => !r.error && r.latitude && r.longitude)
            .map(r => [r.latitude, r.longitude])
          );
          if (bounds.isValid()) {
            mapRef.current.fitBounds(bounds, { padding: [50, 50] });
          }
        }
      }, 200);
    }
  }, [viewMode]);

  const updateMapMarkers = () => {
    if (!markersLayerRef.current) return;
    markersLayerRef.current.clearLayers();
    
    if (results.length === 0) return;

    const bounds = L.latLngBounds([]);
    
    results.forEach((res) => {
      if (res.error || !res.latitude || !res.longitude) return;

      const color = res.matchConfidence > 0.8 ? '#14b8a6' : res.matchConfidence > 0.5 ? '#f59e0b' : '#ef4444';
      
      const markerHtml = `
        <div style="background-color: ${color}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.3);"></div>
      `;

      const icon = L.divIcon({
        html: markerHtml,
        className: '',
        iconSize: [12, 12]
      });

      const marker = L.marker([res.latitude, res.longitude], { icon })
        .bindPopup(`
          <div class="p-2">
            <h4 class="font-black text-slate-800 text-sm mb-1">${res.standardized}</h4>
            <p class="text-[10px] text-slate-500 uppercase font-bold">${res.neighborhood}</p>
            <div class="mt-2 pt-2 border-t border-slate-100 flex flex-col gap-1">
              <div class="flex justify-between items-center">
                <span class="text-[9px] font-black text-teal-600 uppercase">Confiança: ${Math.round(res.matchConfidence * 100)}%</span>
                ${res.source ? `<span class="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Fonte: ${res.source}</span>` : ''}
              </div>
            </div>
          </div>
        `);
      
      markersLayerRef.current.addLayer(marker);
      bounds.extend([res.latitude, res.longitude]);
    });

    if (results.length > 0 && mapRef.current) {
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    }
  };

  const parseAnyFile = async (file: File): Promise<FileData> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const fileName = file.name.toLowerCase();
      const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
      const isCsv = fileName.endsWith('.csv');

      reader.onload = (e) => {
        try {
          let columns: string[] = [];
          let rows: Record<string, any>[] = [];
          let geometries: any[] = [];
          
          if (isExcel || isCsv) {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" }) as Record<string, any>[];
            if (jsonData.length > 0) { 
              columns = Object.keys(jsonData[0]); 
              rows = jsonData; 
            }
          } else {
            const content = e.target?.result as string;
            if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
              const data = JSON.parse(content) as GeoJsonData;
              if (data.features?.length > 0) {
                const allKeys = new Set<string>();
                data.features.forEach(f => {
                  if (f.properties) {
                    Object.keys(f.properties).forEach(k => allKeys.add(k));
                  }
                });
                
                if (allKeys.size > 0) {
                  columns = Array.from(allKeys);
                  rows = data.features.map(f => f.properties || {});
                  geometries = data.features.map(f => f.geometry);
                }
              }
            }
          }
          
          if (columns.length > 0) resolve({ name: file.name, columns, rawRows: rows, geometries: geometries.length > 0 ? geometries : undefined });
          else reject(new Error("Não foi possível identificar colunas no arquivo. Verifique o formato."));
        } catch (err) { reject(err); }
      };
      
      if (isExcel || isCsv) reader.readAsArrayBuffer(file);
      else reader.readAsText(file);
    });
  };

  const handleOfficialFileUpload = async (e: any) => {
    const files = e.target.files;
    if (!files) return;
    setStatus(AppStatus.PARSING_FILE);
    try {
      const newFiles = await Promise.all((Array.from(files) as File[]).map(async f => {
        const data = await parseAnyFile(f);
        const auto = data.columns.find(c => ['NOME', 'LOGRADOURO', 'RUA', 'LOG', 'NOME_LOG'].includes(c.toUpperCase()));
        return { ...data, selectedCol: auto || '' };
      }));
      setOfficialFileDatas(prev => [...prev, ...newFiles]);
      setStatus(AppStatus.IDLE);
    } catch (err: any) { setStatus(AppStatus.IDLE); setError("Erro na Base"); setDetailedError(err.message); }
  };

  const removeOfficialFile = (index: number) => {
    setOfficialFileDatas(prev => prev.filter((_, i) => i !== index));
  };

  const removeInputFile = (index: number) => {
    setInputFileDatas(prev => prev.filter((_, i) => i !== index));
  };

  const handleInputFileUpload = async (e: any) => {
    const files = e.target.files;
    if (!files) return;
    try {
      const newFiles = await Promise.all((Array.from(files) as File[]).map(async f => {
        const data = await parseAnyFile(f);
        const auto = data.columns.find(c => ['ENDERECO', 'ADDRESS', 'LOG'].includes(c.toUpperCase()));
        return { ...data, selectedCol: auto || '', type: f.name.split('.').pop()?.toUpperCase() || '' };
      }));
      setInputFileDatas(prev => [...prev, ...newFiles]);
    } catch (err: any) { setError("Erro no Lote"); setDetailedError(err.message); }
  };

  const geocodeWithNominatim = async (address: string): Promise<{ lat: number, lon: number } | null> => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address + ", Juiz de Fora, MG, Brasil")}&limit=1`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'InteligenciaGeografica/1.0' }
      });
      const data = await response.json();
      if (data && data.length > 0) {
        return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      }
    } catch (e) {
      console.error("Erro no Nominatim:", e);
    }
    return null;
  };

  const geocodeWithIBGE = async (address: string): Promise<{ lat: number, lon: number } | null> => {
    try {
      // O IBGE Geocodificador pode ser instável ou ter restrições de CORS
      // Adicionamos um timeout e tratamos erros de rede silenciosamente para fallback
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const url = `https://geocodificador.ibge.gov.br/geocodificador/endereco?q=${encodeURIComponent(address + ", Juiz de Fora, MG")}`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) return null;
      const data = await response.json();
      
      if (data && data.length > 0) {
        const best = data[0];
        if (best.latitude && best.longitude) {
          return { lat: parseFloat(best.latitude), lon: parseFloat(best.longitude) };
        }
      }
    } catch (e) {
      // Falha silenciosa para permitir o fallback para Nominatim
      console.warn("IBGE CNEFE indisponível ou erro de CORS. Usando fallback...");
    }
    return null;
  };

  const focusOnAddress = (res: AddressResult) => {
    if (!res.latitude || !res.longitude) return;
    
    setViewMode('map');
    
    // Pequeno delay para garantir que o mapa invalidou o tamanho se estava oculto
    setTimeout(() => {
      if (mapRef.current) {
        mapRef.current.setView([res.latitude, res.longitude], 18);
        
        // Encontrar o marcador no cluster e abrir o popup
        if (markersLayerRef.current) {
          const markers = markersLayerRef.current.getLayers();
          const marker = markers.find((m: any) => {
            const latLng = m.getLatLng();
            // Comparação com pequena margem de erro para floats
            return Math.abs(latLng.lat - res.latitude) < 0.00001 && 
                   Math.abs(latLng.lng - res.longitude) < 0.00001;
          });
          
          if (marker) {
            markersLayerRef.current.zoomToShowLayer(marker, () => {
              marker.openPopup();
            });
          }
        }
      }
    }, 300);
  };

  const processAddresses = async () => {
    let list: string[] = inputMode === 'manual' ? inputAddresses.split('\n').filter(a => a.trim()) : 
      inputFileDatas.flatMap(f => f.selectedCol ? f.rawRows.map(r => String(r[f.selectedCol] || '').trim()).filter(a => a) : []);

    if (list.length === 0 || officialStreets.length === 0) {
      setError("Faltam dados");
      setDetailedError("Verifique se selecionou as colunas e a base oficial.");
      return;
    }

    setStatus(AppStatus.PROCESSING);
    setError(null);
    setResults([]);
    setProgress({ current: 0, total: list.length });
    setStartTime(Date.now());
    setEstimatedTime(null);

    // Mapeamento de logradouro para geometria (se disponível)
    const streetToGeom = new Map<string, { lat: number, lon: number }>();
    officialFileDatas.forEach(f => {
      if (f.selectedCol && f.geometries) {
        f.rawRows.forEach((row, idx) => {
          const street = String(row[f.selectedCol]).toUpperCase();
          const geom = f.geometries![idx];
          if (street && geom) {
            if (geom.type === 'Point') {
              streetToGeom.set(street, { lat: geom.coordinates[1], lon: geom.coordinates[0] });
            } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
              const coords = geom.type === 'LineString' ? geom.coordinates[0] : geom.coordinates[0][0];
              streetToGeom.set(street, { lat: coords[1], lon: coords[0] });
            }
          }
        });
      }
    });

    try {
      const batchSize = 15; // Reduzido para 15 para evitar 429 do Gemini
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        try {
          const batchResults = await geminiService.current.standardizeBatch(batch, officialStreets);
          
          for (const res of batchResults) {
            res.source = 'IA';

            const localGeom = streetToGeom.get(res.streetName.toUpperCase());
            if (localGeom) {
              res.latitude = localGeom.lat;
              res.longitude = localGeom.lon;
              res.matchConfidence = Math.max(res.matchConfidence, 0.95);
              res.source = 'Local';
            } 
            else if (res.matchConfidence < 0.6 || (res.latitude === 0 && res.longitude === 0)) {
              // Tenta IBGE
              const ibgeGeom = await geocodeWithIBGE(res.standardized);
              if (ibgeGeom) {
                res.latitude = ibgeGeom.lat;
                res.longitude = ibgeGeom.lon;
                res.matchConfidence = Math.max(res.matchConfidence, 0.9);
                res.source = 'IBGE';
              } else {
                // Tenta Nominatim com delay para respeitar limite de 1 req/sec
                await new Promise(resolve => setTimeout(resolve, 1100));
                const osmGeom = await geocodeWithNominatim(res.standardized);
                if (osmGeom) {
                  res.latitude = osmGeom.lat;
                  res.longitude = osmGeom.lon;
                  res.matchConfidence = Math.max(res.matchConfidence, 0.85);
                  res.source = 'OSM';
                } else if (res.latitude === 0) {
                  res.source = 'Erro';
                }
              }
            }
          }

          setResults(prev => [...prev, ...batchResults]);
          
          const currentProgress = Math.min(i + batchSize, list.length);
          setProgress({ current: currentProgress, total: list.length });

          // Calcular ETA
          if (startTime) {
            const elapsed = Date.now() - startTime;
            const remaining = (elapsed / currentProgress) * (list.length - currentProgress);
            
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            
            if (minutes > 0) {
              setEstimatedTime(`${minutes}m ${seconds}s restantes`);
            } else if (seconds > 0) {
              setEstimatedTime(`${seconds}s restantes`);
            } else {
              setEstimatedTime("Quase lá...");
            }
          }

          // Delay entre lotes aumentado para 1.5s para evitar 429
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (batchErr: any) {
          console.error("Erro no lote:", batchErr);
          // Adiciona erros simulados para manter a contagem correta
          const errorResults = batch.map(addr => ({
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
            error: batchErr.message || "Erro desconhecido no lote"
          }));
          setResults(prev => [...prev, ...errorResults]);
          
          const currentProgress = Math.min(i + batchSize, list.length);
          setProgress({ current: currentProgress, total: list.length });
        }
      }
      setStatus(AppStatus.COMPLETED);
      if (viewMode === 'list') setViewMode('map'); 
    } catch (err: any) { 
      setStatus(AppStatus.IDLE); 
      setError("Erro no Processamento"); 
      setDetailedError(err.message); 
    }
  };

  useEffect(() => {
    const streets = new Set<string>();
    officialFileDatas.forEach(f => {
      if (f.selectedCol) {
        f.rawRows.forEach(r => {
          if (r[f.selectedCol]) streets.add(String(r[f.selectedCol]).toUpperCase());
        });
      }
    });
    setOfficialStreets(Array.from(streets).sort());
  }, [officialFileDatas]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <header className="bg-teal-900 text-white p-4 md:p-6 shadow-xl border-b-4 border-teal-950">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3 md:gap-4 w-full md:w-auto">
            <div className="bg-white/10 p-2 md:p-3 rounded-xl md:rounded-2xl backdrop-blur-sm border border-white/20 shadow-inner shrink-0">
              <i className="fa-solid fa-map-location-dot text-2xl md:text-3xl text-teal-300"></i>
            </div>
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-black tracking-tight uppercase truncate">Inteligência <span className="text-teal-400">Geográfica</span></h1>
              <p className="text-teal-200/70 text-[10px] md:text-sm font-bold">Padronização e Geocodificação • Juiz de Fora</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center md:justify-end gap-3 md:gap-4 w-full md:w-auto">
             <button 
               onClick={() => { setOnboardingStep(0); setShowOnboarding(true); }}
               className="flex items-center gap-2 px-3 md:px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest border border-white/10 transition-all"
             >
               <i className="fa-solid fa-circle-question text-teal-300"></i> Tutorial
             </button>
             <div className="flex gap-1 px-3 md:px-4 py-2 bg-teal-500/20 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest border border-white/10">
               <i className="fa-solid fa-location-crosshairs text-teal-400"></i> IA Espacial Ativa
             </div>
             <div className="h-8 md:h-10 w-[1px] bg-white/10 hidden sm:block"></div>
             <div className="flex flex-col items-center md:items-end">
               <p className="text-[8px] md:text-[10px] font-black text-teal-300 uppercase tracking-widest">Status do Sistema</p>
               <p className="text-[10px] md:text-xs font-bold flex items-center gap-2">
                 <span className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full animate-pulse ${status === AppStatus.PROCESSING ? 'bg-amber-400' : 'bg-teal-400'}`}></span>
                 {status === AppStatus.PROCESSING ? 'Processando...' : 'Pronto'}
               </p>
             </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-10 space-y-10">
        {error && (
          <div className="bg-red-50 border-2 border-red-200 p-6 rounded-[2.5rem] flex gap-6 animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center flex-shrink-0"><i className="fa-solid fa-circle-xmark text-red-600 text-xl"></i></div>
            <div><h3 className="text-red-900 font-black uppercase text-sm">{error}</h3><p className="text-red-700 text-xs mt-1">{detailedError}</p></div>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600"><i className="fa-solid fa-xmark"></i></button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-4 space-y-8">
            {/* ETAPA 1 */}
            <section className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-200">
              <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-6 h-6 bg-teal-600 text-white rounded-lg flex items-center justify-center text-[10px]">1</span> Base de Referência
              </h2>
              <div className="relative group cursor-pointer">
                <input type="file" multiple accept=".geojson,.json,.csv,.xlsx,.xls" onChange={handleOfficialFileUpload} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                <div className={`p-6 border-2 border-dashed rounded-3xl flex flex-col items-center transition-all ${officialFileDatas.length > 0 ? 'bg-teal-50 border-teal-400' : 'bg-slate-50 border-slate-200 group-hover:border-teal-300'}`}>
                  <i className={`fa-solid ${officialFileDatas.length > 0 ? 'fa-check-circle text-teal-600' : 'fa-cloud-arrow-up text-slate-300'} text-2xl mb-2`}></i>
                  <span className="text-[10px] font-black text-slate-500 uppercase">Upload GeoJSON / CSV / XLSX</span>
                </div>
              </div>
              
              {officialFileDatas.length > 0 && (
                <div className="mt-4 space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                  {officialFileDatas.map((f, i) => (
                    <div key={i} className="p-3 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-black text-slate-700 truncate max-w-[150px]">{f.name}</p>
                        <button onClick={() => removeOfficialFile(i)} className="text-slate-300 hover:text-red-500 transition-colors"><i className="fa-solid fa-trash-can text-[10px]"></i></button>
                      </div>
                      <select value={f.selectedCol} onChange={e => {
                        const updated = [...officialFileDatas];
                        updated[i].selectedCol = e.target.value;
                        setOfficialFileDatas(updated);
                      }} className="w-full text-[9px] font-bold bg-white border border-slate-200 p-2 rounded-lg outline-none focus:ring-1 focus:ring-teal-500">
                        <option value="">Coluna do Logradouro...</option>
                        {f.columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ETAPA 2 */}
            <section className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-200">
              <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-6 h-6 bg-teal-600 text-white rounded-lg flex items-center justify-center text-[10px]">2</span> Dados de Entrada
              </h2>
              <div className="flex bg-slate-100 p-1 rounded-2xl mb-4">
                <button onClick={() => setInputMode('file')} className={`flex-1 py-2 rounded-xl text-[9px] font-black uppercase transition-all ${inputMode === 'file' ? 'bg-white shadow-sm text-teal-600' : 'text-slate-400'}`}>Arquivos</button>
                <button onClick={() => setInputMode('manual')} className={`flex-1 py-2 rounded-xl text-[9px] font-black uppercase transition-all ${inputMode === 'manual' ? 'bg-white shadow-sm text-teal-600' : 'text-slate-400'}`}>Manual</button>
              </div>

              {inputMode === 'file' ? (
                <div className="space-y-4">
                  <div className="relative group cursor-pointer">
                    <input type="file" multiple accept=".geojson,.json,.csv,.xlsx,.xls" onChange={handleInputFileUpload} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="p-6 border-2 border-dashed border-slate-200 bg-slate-50 rounded-3xl flex flex-col items-center group-hover:border-teal-400 transition-all">
                      <i className="fa-solid fa-plus-circle text-slate-300 text-2xl mb-2 group-hover:text-teal-500"></i>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-tighter">Adicionar ao Lote</span>
                    </div>
                  </div>
                  <div className="max-h-60 overflow-y-auto space-y-2 custom-scrollbar pr-1">
                    {inputFileDatas.map((f, i) => (
                      <div key={i} className="p-3 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-black text-slate-700 truncate max-w-[150px]">{f.name}</p>
                          <button onClick={() => removeInputFile(i)} className="text-slate-300 hover:text-red-500 transition-colors"><i className="fa-solid fa-trash-can text-[10px]"></i></button>
                        </div>
                        <select value={f.selectedCol} onChange={e => {
                          const updated = [...inputFileDatas];
                          updated[i].selectedCol = e.target.value;
                          setInputFileDatas(updated);
                        }} className="w-full text-[9px] font-bold bg-white border border-slate-200 p-2 rounded-lg outline-none focus:ring-1 focus:ring-teal-500">
                          <option value="">Coluna do Endereço...</option>
                          {f.columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <textarea value={inputAddresses} onChange={e => setInputAddresses(e.target.value)} placeholder="Endereços (um por linha)..." className="w-full h-32 p-4 text-[11px] bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-teal-500 font-mono outline-none" />
              )}

              <button onClick={processAddresses} disabled={status === AppStatus.PROCESSING} className="w-full mt-6 py-4 bg-teal-600 text-white rounded-3xl font-black text-xs shadow-lg shadow-teal-100 hover:translate-y-[-2px] transition-all active:scale-95 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">
                {status === AppStatus.PROCESSING ? <i className="fa-solid fa-circle-notch fa-spin mr-2"></i> : <i className="fa-solid fa-location-arrow mr-2"></i>}
                PADRONIZAR E MAPEAR
              </button>
            </section>
          </div>

          <div className="lg:col-span-8 space-y-8 flex flex-col h-auto lg:h-[800px]">
            <section className="bg-white rounded-3xl lg:rounded-[3rem] shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[600px] lg:h-full ring-1 ring-slate-100">
              <div className="p-4 md:p-6 border-b border-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex gap-2 bg-slate-100 p-1 rounded-2xl w-full sm:w-auto">
                  <button onClick={() => setViewMode('list')} className={`flex-1 sm:flex-none px-4 md:px-6 py-2 rounded-xl text-[10px] font-black uppercase transition-all flex items-center justify-center gap-2 ${viewMode === 'list' ? 'bg-white shadow-sm text-teal-600' : 'text-slate-400'}`}>
                    <i className="fa-solid fa-list-ul"></i> Lista
                  </button>
                  <button onClick={() => setViewMode('map')} className={`flex-1 sm:flex-none px-4 md:px-6 py-2 rounded-xl text-[10px] font-black uppercase transition-all flex items-center justify-center gap-2 ${viewMode === 'map' ? 'bg-white shadow-sm text-teal-600' : 'text-slate-400'}`}>
                    <i className="fa-solid fa-map-location-dot"></i> Mapa
                  </button>
                </div>
                {results.length > 0 && (
                  <div className="flex items-center justify-between sm:justify-end gap-3 md:gap-4 w-full sm:w-auto">
                    <button 
                      onClick={() => {
                        const worksheet = XLSX.utils.json_to_sheet(results);
                        const workbook = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(workbook, worksheet, "Resultados");
                        XLSX.writeFile(workbook, "resultados_geocodificacao.xlsx");
                      }}
                      className="px-3 md:px-4 py-2 bg-teal-600 text-white rounded-xl text-[9px] md:text-[10px] font-black uppercase transition-all flex items-center gap-2 hover:bg-teal-700 shadow-sm"
                    >
                      <i className="fa-solid fa-file-export"></i> <span className="hidden xs:inline">Exportar XLSX</span><span className="xs:hidden">XLSX</span>
                    </button>
                    <span className="text-[9px] md:text-[10px] font-black text-teal-600 uppercase tracking-widest bg-teal-50 px-3 py-1.5 rounded-xl border border-teal-100 whitespace-nowrap">{results.length} <span className="hidden xs:inline">Geocodificados</span><span className="xs:hidden">Pontos</span></span>
                  </div>
                )}
              </div>

              <div className="flex-1 relative overflow-hidden">
                {status === AppStatus.PROCESSING && (
                  <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6 md:p-10 text-center">
                    <div className="w-16 h-16 md:w-20 md:h-20 relative mb-4 md:mb-6">
                      <div className="absolute inset-0 border-4 border-teal-100 rounded-full"></div>
                      <div 
                        className="absolute inset-0 border-4 border-teal-600 rounded-full border-t-transparent animate-spin"
                        style={{ animationDuration: '1s' }}
                      ></div>
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-teal-600">
                        {Math.round((progress.current / progress.total) * 100)}%
                      </div>
                    </div>
                    <p className="text-xs font-black text-teal-900 uppercase tracking-widest mb-1 md:mb-2">Processando Endereços</p>
                    <p className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                      Lote {Math.ceil(progress.current / 15)} de {Math.ceil(progress.total / 15)} • {progress.current}/{progress.total} concluídos
                    </p>
                    {estimatedTime && (
                      <p className="text-[8px] md:text-[9px] font-black text-teal-600 uppercase tracking-widest mt-2 flex items-center gap-1">
                        <i className="fa-solid fa-clock animate-pulse"></i> {estimatedTime}
                      </p>
                    )}
                    <div className="w-40 md:w-48 h-1.5 bg-slate-100 rounded-full mt-4 overflow-hidden">
                      <div 
                        className="h-full bg-teal-600 transition-all duration-500" 
                        style={{ width: `${(progress.current / progress.total) * 100}%` }}
                      ></div>
                    </div>
                  </div>
                )}

                <div className={`h-full overflow-y-auto custom-scrollbar ${viewMode === 'list' ? 'block' : 'hidden'}`}>
                  {results.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 p-10 text-center">
                      <i className="fa-solid fa-database text-5xl md:text-6xl text-teal-900 mb-4"></i>
                      <p className="text-[10px] md:text-xs font-black uppercase tracking-widest">Sem dados no visor</p>
                    </div>
                  ) : (
                    <>
                      {/* Mobile Card View */}
                      <div className="block md:hidden divide-y divide-slate-100">
                        {results.map((r, i) => (
                          <div key={i} className={`p-4 space-y-3 ${r.error ? 'bg-red-50/30' : ''}`}>
                            <div className="flex justify-between items-start gap-4">
                              <div className="min-w-0 flex-1">
                                {r.error ? (
                                  <div>
                                    <p className="text-[11px] font-black text-red-600 leading-tight flex items-center gap-1">
                                      <i className="fa-solid fa-triangle-exclamation"></i> Falha
                                    </p>
                                    <p className="text-[10px] font-bold text-red-400 uppercase mt-1">{r.error}</p>
                                  </div>
                                ) : (
                                  <>
                                    <p className="text-[13px] font-black text-slate-800 leading-tight break-words">{r.standardized}</p>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase mt-1">{r.neighborhood} • JF</p>
                                  </>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-2 shrink-0">
                                <div className="flex items-center gap-1.5">
                                  <div className={`w-1.5 h-1.5 rounded-full ${r.error ? 'bg-red-400' : r.matchConfidence > 0.8 ? 'bg-teal-500' : 'bg-amber-400'}`}></div>
                                  <span className={`text-[10px] font-black ${r.error ? 'text-red-400' : 'text-slate-700'}`}>
                                    {r.error ? '0%' : `${Math.round(r.matchConfidence * 100)}%`}
                                  </span>
                                </div>
                                {!r.error && r.latitude && r.longitude && (
                                  <button 
                                    onClick={() => focusOnAddress(r)}
                                    className="w-8 h-8 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center shadow-sm"
                                  >
                                    <i className="fa-solid fa-location-dot text-xs"></i>
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between pt-2 border-t border-slate-50">
                              <p className="text-[9px] text-slate-400 font-mono truncate max-w-[180px] italic">Orig: {r.original}</p>
                              {r.source && !r.error && (
                                <span className="text-[8px] font-bold text-slate-300 uppercase tracking-tighter">Fonte: {r.source}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Desktop Table View */}
                      <table className="hidden md:table w-full text-left">
                        <thead className="bg-slate-50/50 sticky top-0 backdrop-blur-sm">
                          <tr>
                            <th className="px-8 py-4 text-[9px] font-black text-slate-400 uppercase">Original</th>
                            <th className="px-8 py-4 text-[9px] font-black text-slate-400 uppercase">Padronizado</th>
                            <th className="px-8 py-4 text-[9px] font-black text-slate-400 uppercase">Score</th>
                            <th className="px-8 py-4 text-[9px] font-black text-slate-400 uppercase text-center">Ações</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {results.map((r, i) => (
                            <tr key={i} className={`hover:bg-slate-50/50 transition-all cursor-default group ${r.error ? 'bg-red-50/30' : ''}`}>
                              <td className="px-8 py-5 text-[10px] text-slate-400 font-mono truncate max-w-[150px]">{r.original}</td>
                              <td className="px-8 py-5">
                                {r.error ? (
                                  <div>
                                    <p className="text-[11px] font-black text-red-600 leading-tight flex items-center gap-1">
                                      <i className="fa-solid fa-triangle-exclamation"></i> Falha
                                    </p>
                                    <p className="text-[9px] font-bold text-red-400 uppercase mt-0.5">{r.error}</p>
                                  </div>
                                ) : (
                                  <>
                                    <p className="text-[12px] font-black text-slate-800 leading-tight">{r.standardized}</p>
                                    <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">{r.neighborhood} • JF</p>
                                  </>
                                )}
                              </td>
                              <td className="px-8 py-5">
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${r.error ? 'bg-red-400' : r.matchConfidence > 0.8 ? 'bg-teal-500' : 'bg-amber-400'}`}></div>
                                    <span className={`text-[10px] font-black ${r.error ? 'text-red-400' : 'text-slate-700'}`}>
                                      {r.error ? '0%' : `${Math.round(r.matchConfidence * 100)}%`}
                                    </span>
                                  </div>
                                  {r.source && !r.error && (
                                    <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Fonte: {r.source}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-8 py-5 text-center">
                                {!r.error && r.latitude && r.longitude && (
                                  <button 
                                    onClick={() => focusOnAddress(r)}
                                    className="w-8 h-8 rounded-full bg-slate-100 text-slate-400 hover:bg-teal-50 hover:text-teal-600 transition-all flex items-center justify-center group/btn"
                                    title="Ver no Mapa"
                                  >
                                    <i className="fa-solid fa-location-dot text-xs group-hover/btn:scale-110 transition-transform"></i>
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>

                <div className={`h-full p-4 ${viewMode === 'map' ? 'block' : 'hidden'}`}>
                  <div id="map" className="shadow-inner border border-slate-100"></div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="bg-white border-t border-slate-200 py-8 px-10 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center text-slate-400 text-[9px] font-black uppercase tracking-[0.2em]">
          <p>© 2024 Inteligência Geográfica • Juiz de Fora</p>
          <div className="flex gap-8">
            <span className="flex items-center gap-2 hover:text-teal-600 transition-colors cursor-default"><i className="fa-solid fa-earth-americas"></i> Leaflet Engined</span>
            <span className="flex items-center gap-2 hover:text-teal-600 transition-colors cursor-default"><i className="fa-solid fa-brain"></i> Gemini 3 AI</span>
          </div>
        </div>
      </footer>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>

      {/* Onboarding Overlay */}
      <AnimatePresence>
        {showOnboarding && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1000] bg-teal-950/80 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-2xl rounded-3xl md:rounded-[3rem] shadow-2xl overflow-hidden flex flex-col md:flex-row h-[90vh] md:h-[500px]"
            >
              {/* Sidebar do Tutorial */}
              <div className="bg-teal-900 w-full md:w-64 p-6 md:p-8 text-white flex flex-row md:flex-col justify-between items-center md:items-stretch shrink-0">
                <div className="flex md:block items-center gap-4">
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-white/10 rounded-xl md:rounded-2xl flex items-center justify-center mb-0 md:mb-6 border border-white/20">
                    <i className="fa-solid fa-graduation-cap text-xl md:text-2xl text-teal-300"></i>
                  </div>
                  <div>
                    <h3 className="text-lg md:text-xl font-black uppercase tracking-tighter leading-none mb-1 md:mb-2">Guia de<br className="hidden md:block"/>Início</h3>
                    <p className="text-teal-300/60 text-[8px] md:text-[10px] font-bold uppercase tracking-widest">Passo {onboardingStep + 1} de 5</p>
                  </div>
                </div>
                
                <div className="flex md:flex-col gap-1 md:gap-2 w-24 md:w-auto">
                  {[0, 1, 2, 3, 4].map(s => (
                    <div key={s} className={`h-1 rounded-full transition-all duration-500 ${s <= onboardingStep ? 'bg-teal-400 flex-1' : 'bg-white/10 w-2 md:w-4'}`}></div>
                  ))}
                </div>
              </div>

              {/* Conteúdo do Passo */}
              <div className="flex-1 p-6 md:p-10 flex flex-col justify-between relative overflow-y-auto custom-scrollbar">
                <button 
                  onClick={closeOnboarding}
                  className="absolute top-4 right-4 md:top-6 md:right-6 text-slate-300 hover:text-slate-600 transition-colors z-10"
                >
                  <i className="fa-solid fa-xmark text-xl"></i>
                </button>

                <AnimatePresence mode="wait">
                  <motion.div
                    key={onboardingStep}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="space-y-4 md:space-y-6"
                  >
                    {onboardingStep === 0 && (
                      <>
                        <div className="inline-block px-3 py-1 bg-teal-50 text-teal-600 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest">Bem-vindo</div>
                        <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">Domine a Inteligência Geográfica</h2>
                        <p className="text-slate-500 text-xs md:text-sm leading-relaxed">
                          Este sistema foi projetado para padronizar endereços confusos e transformá-los em coordenadas precisas em Juiz de Fora, utilizando IA e bases oficiais.
                        </p>
                      </>
                    )}
                    {onboardingStep === 1 && (
                      <>
                        <div className="inline-block px-3 py-1 bg-teal-50 text-teal-600 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest">Passo 1</div>
                        <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">Base de Referência</h2>
                        <p className="text-slate-500 text-xs md:text-sm leading-relaxed">
                          Comece carregando sua <b>Base Oficial</b> (GeoJSON, CSV ou XLSX). O sistema usará esses nomes de ruas como verdade absoluta para corrigir seus dados.
                        </p>
                        <div className="p-3 md:p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-3 md:gap-4">
                          <i className="fa-solid fa-database text-teal-600 text-lg md:text-xl"></i>
                          <p className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase">Dica: Selecione a coluna correta do logradouro após o upload.</p>
                        </div>
                      </>
                    )}
                    {onboardingStep === 2 && (
                      <>
                        <div className="inline-block px-3 py-1 bg-teal-50 text-teal-600 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest">Passo 2</div>
                        <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">Dados de Entrada</h2>
                        <p className="text-slate-500 text-xs md:text-sm leading-relaxed">
                          Insira os endereços que deseja geocodificar. Você pode colar manualmente uma lista ou fazer o upload de arquivos em lote.
                        </p>
                        <div className="flex gap-2">
                          <div className="px-3 md:px-4 py-2 bg-white border border-slate-200 rounded-xl text-[8px] md:text-[9px] font-black text-slate-400 uppercase">Manual</div>
                          <div className="px-3 md:px-4 py-2 bg-white border border-slate-200 rounded-xl text-[8px] md:text-[9px] font-black text-slate-400 uppercase">Arquivo</div>
                        </div>
                      </>
                    )}
                    {onboardingStep === 3 && (
                      <>
                        <div className="inline-block px-3 py-1 bg-teal-50 text-teal-600 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest">Passo 3</div>
                        <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">Processamento Inteligente</h2>
                        <p className="text-slate-500 text-xs md:text-sm leading-relaxed">
                          Ao clicar em <b>Padronizar e Mapear</b>, nossa IA entra em ação cruzando dados com o IBGE e OpenStreetMap para garantir a melhor confiança.
                        </p>
                        <div className="flex items-center gap-2 text-emerald-500 font-black text-[9px] md:text-[10px] uppercase tracking-widest">
                          <i className="fa-solid fa-bolt"></i> Alta Performance Ativa
                        </div>
                      </>
                    )}
                    {onboardingStep === 4 && (
                      <>
                        <div className="inline-block px-3 py-1 bg-teal-50 text-teal-600 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest">Final</div>
                        <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">Resultados e Exportação</h2>
                        <p className="text-slate-500 text-xs md:text-sm leading-relaxed">
                          Visualize os pontos no mapa interativo ou na lista detalhada com score de confiança. Quando terminar, exporte tudo para Excel com um clique.
                        </p>
                        <button 
                          onClick={closeOnboarding}
                          className="w-full py-3 md:py-4 bg-teal-600 text-white rounded-2xl font-black text-[10px] md:text-xs uppercase tracking-widest shadow-lg shadow-teal-100 hover:bg-teal-700 transition-all"
                        >
                          Começar a Usar
                        </button>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>

                {onboardingStep < 4 && (
                  <div className="flex justify-between items-center mt-6 md:mt-8">
                    <button 
                      onClick={() => setOnboardingStep(prev => Math.max(0, prev - 1))}
                      disabled={onboardingStep === 0}
                      className="text-slate-400 font-black text-[9px] md:text-[10px] uppercase tracking-widest disabled:opacity-0 transition-all"
                    >
                      Anterior
                    </button>
                    <button 
                      onClick={() => setOnboardingStep(prev => Math.min(4, prev + 1))}
                      className="px-6 md:px-8 py-2 md:py-3 bg-slate-900 text-white rounded-xl font-black text-[9px] md:text-[10px] uppercase tracking-widest hover:bg-slate-800 transition-all"
                    >
                      Próximo
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
