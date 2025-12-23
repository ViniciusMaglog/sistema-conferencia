'use client';

import { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { 
  FileSpreadsheet, CheckCircle, Save, Database, 
  History, Search, Filter, RefreshCw, AlertTriangle, ArrowRightLeft 
} from 'lucide-react';
import Link from 'next/link';

export default function ConferenciaEstoque() {
  const [files, setFiles] = useState<{c1: File | null, c2: File | null, sys: File | null}>({ c1: null, c2: null, sys: null });
  const [dadosProcessados, setDadosProcessados] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [filtros, setFiltros] = useState({ local: '', gtin: '', desc: '', status: '' });

  // Controle de Modo
  const [modoAuditoria, setModoAuditoria] = useState(false);
  const [rodadaAtual, setRodadaAtual] = useState(3);

  // --- HELPER: LEITURA DE EXCEL ---
  const lerExcel = async (file: File) => {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<any>(sheet);
  };

  const norm = (txt: any) => String(txt || '').trim().toUpperCase();

  const getDesc = (row: any) => {
    return row['Descrição'] || row['Descricao'] || row['Descrição do Produto'] || row['Produto'] || row['Material'] || row['Description'] || '';
  };

  // --- LÓGICA 1: MODO INICIAL (1ª e 2ª) ---
  const processarInicial = async () => {
    if (!files.sys) { alert("Arquivo de Sistema é obrigatório."); return; }
    
    setLoading(true);
    try {
      const rawSys = await lerExcel(files.sys as any);
      const raw1 = files.c1 ? await lerExcel(files.c1 as any) : [];
      const raw2 = files.c2 ? await lerExcel(files.c2 as any) : [];

      const mapa = new Map();
      const saldosGlobais = new Map(); 

      // 1. Carrega Sistema (Saldos Globais)
      rawSys.forEach((row: any) => {
        const gtin = norm(row['GTIN'] || row['Codigo']);
        const lote = norm(row['Lote'] || row['Batch']);
        const local = norm(row['Localização'] || row['Localizacao']);
        const qtd = Number(row['Armazenado'] || row['Qtd_Sistema'] || 0);
        
        const chaveGlobal = `${gtin}|${lote}`;
        if (!saldosGlobais.has(chaveGlobal)) saldosGlobais.set(chaveGlobal, { sys: 0, fis: 0, locaisEsperados: new Set() });
        const global = saldosGlobais.get(chaveGlobal);
        global.sys += qtd;
        global.locaisEsperados.add(local);
      });

      // 2. Processa Linhas
      const processar = (row: any, tipo: 'sys'|'c1'|'c2') => {
        const local = norm(row['Localização'] || row['Localizacao'] || row['Local']);
        const gtin = norm(row['GTIN'] || row['Codigo']);
        const lote = norm(row['Lote'] || row['Batch']);
        if (!local || !gtin) return;

        const chave = `${local}|${gtin}|${lote}`;
        const chaveGlobal = `${gtin}|${lote}`;
        const descricaoItem = getDesc(row);

        if (!mapa.has(chave)) {
           const locaisSys = saldosGlobais.get(chaveGlobal)?.locaisEsperados || new Set();
           const locaisStr = Array.from(locaisSys).join(', ');

           mapa.set(chave, {
             idTemp: chave, local, gtin, lote, 
             desc: descricaoItem, 
             qtdSys: 0, qtd1: 0, qtd2: 0, user1: '', user2: '', status: '', acao: '', chaveGlobal,
             locaisSistema: locaisStr
           });
        }
        const item = mapa.get(chave);
        if (descricaoItem && (!item.desc || item.desc === '')) item.desc = descricaoItem;
        
        if (tipo === 'sys') {
            item.qtdSys += Number(row['Armazenado'] || row['Qtd_Sistema'] || 0);
        } else {
            const qtd = Number(row['Quantidade_Contada'] || 0);
            const user = String(row['Usuario'] || '');
            const global = saldosGlobais.get(chaveGlobal) || { sys: 0, fis: 0 };
            
            if (tipo === 'c1') { item.qtd1 += qtd; if(user) item.user1 = user; }
            if (tipo === 'c2') { item.qtd2 += qtd; if(user) item.user2 = user; global.fis += qtd; }
        }
      };

      rawSys.forEach((r: any) => processar(r, 'sys'));
      raw1.forEach((r: any) => processar(r, 'c1'));
      raw2.forEach((r: any) => processar(r, 'c2'));

      // 3. Define Status Inicial
      const resultado = Array.from(mapa.values()).map(item => {
        const global = saldosGlobais.get(item.chaveGlobal);
        const saldoBate = global && global.sys === global.fis;

        if (files.c1 && files.c2 && item.qtd1 !== item.qtd2) {
            return { ...item, status: 'DIVERG. CONTAGEM', acao: 'Enviar para 3ª Contagem' };
        }
        if (saldoBate) {
            if (item.qtd2 === item.qtdSys) return { ...item, status: 'OK', acao: 'Finalizado' };
            return { ...item, status: 'ALERTA LOCAL', acao: 'Transferência Física' };
        } else {
             if (item.qtd2 === item.qtdSys) return { ...item, status: 'OK (PARCIAL)', acao: 'Verificar Outros' };
             const tipo = (item.qtd2 - item.qtdSys) > 0 ? 'SOBRA' : 'FALTA';
             return { ...item, status: tipo, acao: 'Enviar para 3ª Contagem' };
        }
      });

      setDadosProcessados(resultado.sort((a, b) => a.status === 'OK' ? 1 : -1));
    } catch (err) { console.error(err); alert("Erro ao processar."); } 
    finally { setLoading(false); }
  };

  // --- LÓGICA 2: MODO AUDITORIA ---
  const processarAuditoria = async () => {
    if (!files.c1) { alert("Anexe o arquivo da contagem atual."); return; }
    setLoading(true);
    
    try {
        const { data: pendencias, error } = await supabase
            .from('inventario_itens')
            .select('*')
            .not('status_atual', 'eq', 'OK')
            .not('status_atual', 'eq', 'Finalizado');

        if (error) throw error;
        if (!pendencias || pendencias.length === 0) { alert("Não há itens pendentes de auditoria no banco."); return; }

        const rawAudit = await files.c1 ? await lerExcel(files.c1 as any) : [];
        const mapa = new Map();

        pendencias.forEach((dbItem: any) => {
            const chave = `${dbItem.localizacao}|${dbItem.gtin}|${dbItem.lote}`;
            mapa.set(chave, {
                idTemp: chave, dbId: dbItem.id,
                local: dbItem.localizacao, gtin: dbItem.gtin, lote: dbItem.lote,
                desc: dbItem.descricao, 
                qtdSys: dbItem.qtd_sistema,
                qtdAudit: 0, userAudit: '',
                status: 'PENDENTE', acao: 'Item não contado na auditoria'
            });
        });

        rawAudit.forEach((row: any) => {
            const local = norm(row['Localização'] || row['Localizacao'] || row['Local']);
            const gtin = norm(row['GTIN'] || row['Codigo']);
            const lote = norm(row['Lote'] || row['Batch']);
            const qtd = Number(row['Quantidade_Contada'] || 0);
            const user = String(row['Usuario'] || '');
            const descAudit = getDesc(row);

            const chave = `${local}|${gtin}|${lote}`;
            
            if (mapa.has(chave)) {
                const item = mapa.get(chave);
                item.qtdAudit += qtd;
                item.userAudit = user;
            } else {
                mapa.set(chave, {
                    idTemp: chave, local, gtin, lote, 
                    desc: descAudit || 'Novo Item',
                    qtdSys: 0, qtdAudit: qtd, userAudit: user,
                    status: 'ITEM NAO SOLICITADO', acao: 'Verificar origem'
                });
            }
        });

        const resultado = Array.from(mapa.values()).map(item => {
            if (item.qtdAudit === 0 && item.status !== 'ITEM NAO SOLICITADO') return item;
            if (item.qtdAudit === item.qtdSys) {
                return { ...item, status: 'OK', acao: 'Resolvido na Auditoria' };
            } else {
                const diff = item.qtdAudit - item.qtdSys;
                const tipo = diff > 0 ? 'SOBRA CONFIRMADA' : 'FALTA CONFIRMADA';
                const prox = rodadaAtual < 6 ? `Enviar para ${rodadaAtual + 1}ª Contagem` : 'Ajustar Sistema';
                return { ...item, status: tipo, acao: prox };
            }
        });

        setDadosProcessados(resultado.sort((a, b) => a.status === 'OK' ? 1 : -1));

    } catch (err: any) { console.error(err); alert("Erro: " + err.message); }
    finally { setLoading(false); }
  };

  // --- SALVAR NO BANCO ---
  const salvarNoSupabase = async () => {
    if (!confirm(`Gravar ${modoAuditoria ? 'AUDITORIA' : 'INICIAL'} no histórico?`)) return;
    setSalvando(true);
    try {
      const itensMestre = dadosProcessados.map(d => ({
        localizacao: d.local, gtin: d.gtin, lote: d.lote, descricao: d.desc,
        qtd_sistema: d.qtdSys, status_atual: d.status
      }));
      
      const { data: itensSalvos, error: errMestre } = await supabase
        .from('inventario_itens')
        .upsert(itensMestre, { onConflict: 'localizacao,gtin,lote' })
        .select('id, localizacao, gtin, lote');
        
      if (errMestre) throw errMestre;

      const idMap = new Map();
      itensSalvos?.forEach((i: any) => idMap.set(`${i.localizacao}|${i.gtin}|${i.lote}`, i.id));
      
      const contagens = [];
      for (const d of dadosProcessados) {
        const dbId = idMap.get(d.idTemp);
        if (!dbId) continue;
        
        if (!modoAuditoria) {
           if (d.qtd1 !== undefined) contagens.push({ item_id: dbId, rodada: 1, quantidade: d.qtd1, usuario: d.user1 });
           if (d.qtd2 !== undefined) contagens.push({ item_id: dbId, rodada: 2, quantidade: d.qtd2, usuario: d.user2 });
        } else {
           if (d.qtdAudit !== undefined && d.qtdAudit !== 0) {
               contagens.push({ item_id: dbId, rodada: rodadaAtual, quantidade: d.qtdAudit, usuario: d.userAudit });
           }
        }
      }
      
      if (contagens.length > 0) {
          const { error: errCont } = await supabase.from('inventario_contagens').insert(contagens);
          if (errCont) throw errCont;
      }
      alert("Dados atualizados com sucesso!");
    } catch (err: any) { alert("Erro ao salvar: " + err.message); } 
    finally { setSalvando(false); }
  };

  // --- EXPORTAÇÕES ---
  const baixarPlanilha = () => {
      const ws = XLSX.utils.json_to_sheet(dadosFiltrados);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Resultado");
      XLSX.writeFile(wb, `Resultado_Rodada_${modoAuditoria ? rodadaAtual : 'Inicial'}.xlsx`);
  };

  const baixarDivergencias = () => {
    const data = dadosFiltrados.filter(i => !i.status.includes('OK') && !i.status.includes('ALERTA LOCAL'));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Divergencias");
    XLSX.writeFile(wb, "Relatorio_Divergencias.xlsx");
  };

  const baixarTransferencias = () => {
    const data = dadosFiltrados
        .filter(i => i.status === 'ALERTA LOCAL')
        .map(i => ({
            'Local Físico (Bipado)': i.local, 'GTIN': i.gtin, 'Lote': i.lote,
            'Descrição': i.desc, 'Qtd Encontrada': modoAuditoria ? i.qtd1 : i.qtd2,
            'Qtd Sistema Neste Local': i.qtdSys, 'ONDE DEVERIA ESTAR': i.locaisSistema
        }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Transferencias");
    XLSX.writeFile(wb, "Relatorio_Transferencias.xlsx");
  };

  // --- FILTROS VISUAIS ---
  const dadosFiltrados = useMemo(() => {
    return dadosProcessados.filter(item => {
      const qVal = modoAuditoria ? item.qtdAudit : item.qtd2;
      return (
        item.local.includes(filtros.local.toUpperCase()) &&
        (item.gtin.includes(filtros.gtin.toUpperCase()) || item.lote.includes(filtros.gtin.toUpperCase())) &&
        item.desc.toUpperCase().includes(filtros.desc.toUpperCase()) &&
        String(qVal || '').includes('') && 
        item.status.toUpperCase().includes(filtros.status.toUpperCase())
      );
    });
  }, [dadosProcessados, filtros, modoAuditoria]);

  const FilterInput = ({ val, onChange, ph }: any) => (
    <div className="flex items-center bg-white rounded border border-slate-300 mt-1 px-1 h-7">
        <Search size={12} className="text-slate-400 mr-1"/>
        <input type="text" value={val} onChange={e => onChange(e.target.value)} 
            className="w-full text-xs outline-none bg-transparent placeholder-slate-300 uppercase" placeholder={ph}/>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-slate-100 font-sans text-slate-800 overflow-hidden">
      
      {/* HEADER */}
      <header className="bg-white border-b shadow-sm z-20 flex flex-col shrink-0">
        <div className="flex justify-between items-center px-6 py-2 border-b border-slate-100">
            <div className="flex items-center gap-3">
                <img 
                    src="/logo.png" 
                    alt="Logo Empresa" 
                    className="h-8 w-auto object-contain" 
                />
                <h1 className="text-lg font-bold text-slate-900">Conferência de Inventário</h1>
            </div>
            <Link href="/historico" className="text-xs font-semibold text-slate-600 hover:text-blue-600 flex items-center gap-1 bg-slate-50 px-3 py-1.5 rounded-full border">
                <History size={14} /> Histórico
            </Link>
        </div>

        {/* CONTROLES */}
        <div className="flex items-center gap-4 px-6 py-2 overflow-x-auto bg-slate-50">
            {/* Seletor Modo */}
            <div className="flex bg-white border p-0.5 rounded-lg shrink-0">
                <button onClick={() => {setModoAuditoria(false); setDadosProcessados([]);}} className={`px-3 py-1 rounded-md text-xs font-bold transition ${!modoAuditoria ? 'bg-blue-100 text-blue-800' : 'text-slate-500'}`}>Inicial (1ª/2ª)</button>
                <button onClick={() => {setModoAuditoria(true); setDadosProcessados([]);}} className={`px-3 py-1 rounded-md text-xs font-bold transition ${modoAuditoria ? 'bg-purple-100 text-purple-800' : 'text-slate-500'}`}>Auditoria</button>
            </div>

            {/* Inputs Dinâmicos */}
            <div className="flex items-center gap-2 border-l border-slate-200 pl-4 shrink-0">
                {modoAuditoria ? (
                    <>
                        <div className="flex items-center gap-2 px-3 h-8 bg-purple-50 border border-purple-200 rounded text-purple-700 text-xs font-bold">
                            <Database size={14}/> 
                            <span>Comparar com Banco de Dados</span>
                        </div>
                        <select value={rodadaAtual} onChange={(e) => setRodadaAtual(Number(e.target.value))} className="h-8 border rounded text-xs font-bold bg-white">
                            <option value={3}>3ª Rodada</option>
                            <option value={4}>4ª Rodada</option>
                            <option value={5}>5ª Rodada</option>
                        </select>
                        <label className="cursor-pointer flex items-center gap-2 px-3 h-8 rounded border border-purple-300 bg-white text-xs font-semibold text-purple-700 hover:bg-purple-50">
                            <FileSpreadsheet size={14} /> Upload Contagem {rodadaAtual}ª
                            <input type="file" onChange={(e) => setFiles(p => ({...p, c1: e.target.files?.[0] || null}))} className="hidden"/>
                        </label>
                    </>
                ) : (
                    <>
                        <label className={`cursor-pointer px-3 h-8 flex items-center gap-1 rounded border text-xs font-bold ${files.c1 ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-slate-600'}`}>
                            1ª Contagem <input type="file" onChange={e => setFiles(p => ({...p, c1: e.target.files?.[0] || null}))} className="hidden"/>
                        </label>
                        <label className={`cursor-pointer px-3 h-8 flex items-center gap-1 rounded border text-xs font-bold ${files.c2 ? 'bg-indigo-100 text-indigo-700 border-indigo-300' : 'bg-white text-slate-600'}`}>
                            2ª Contagem <input type="file" onChange={e => setFiles(p => ({...p, c2: e.target.files?.[0] || null}))} className="hidden"/>
                        </label>
                        <label className={`cursor-pointer px-3 h-8 flex items-center gap-1 rounded border text-xs font-bold ${files.sys ? 'bg-green-100 text-green-700 border-green-300' : 'bg-white text-slate-600'}`}>
                            Sistema WMS <input type="file" onChange={e => setFiles(p => ({...p, sys: e.target.files?.[0] || null}))} className="hidden"/>
                        </label>
                    </>
                )}
            </div>

            <button onClick={modoAuditoria ? processarAuditoria : processarInicial} disabled={loading} 
                className={`ml-auto h-8 px-4 rounded text-xs font-bold text-white shadow-sm flex items-center gap-2 ${loading ? 'bg-slate-400' : 'bg-blue-600 hover:bg-blue-700'}`}>
                {loading ? <RefreshCw className="animate-spin" size={14}/> : 'Processar'}
            </button>
        </div>

        {/* RESULTADOS ACTIONS */}
        {dadosProcessados.length > 0 && (
            <div className="flex items-center gap-2 px-6 py-2 bg-slate-100 border-t border-slate-200">
                <span className="text-xs font-bold text-slate-600 mr-2">Itens: {dadosFiltrados.length}</span>
                
                <button onClick={salvarNoSupabase} disabled={salvando} className="h-7 px-3 bg-green-600 text-white rounded text-xs font-bold hover:bg-green-700 flex items-center gap-1 shadow-sm">
                    <Save size={14}/> {salvando ? 'Salvando...' : 'Gravar Resultado'}
                </button>
                
                <div className="h-4 w-px bg-slate-300 mx-1"></div>

                <button onClick={baixarDivergencias} className="h-7 px-3 bg-amber-600 text-white rounded text-xs font-bold hover:bg-amber-700 flex items-center gap-1 shadow-sm">
                    <AlertTriangle size={14}/> Baixar Divergências
                </button>

                <button onClick={baixarTransferencias} className="h-7 px-3 bg-purple-600 text-white rounded text-xs font-bold hover:bg-purple-700 flex items-center gap-1 shadow-sm">
                    <ArrowRightLeft size={14}/> Baixar Transferências
                </button>

                <button onClick={baixarPlanilha} className="h-7 px-3 bg-slate-600 text-white rounded text-xs font-bold hover:bg-slate-700 flex items-center gap-1 shadow-sm ml-auto">
                    <FileSpreadsheet size={14}/> Geral
                </button>
            </div>
        )}
      </header>

      {/* TABELA */}
      <main className="flex-1 overflow-auto p-0 bg-white relative w-full">
        {dadosProcessados.length > 0 ? (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-100 sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-4 py-2 text-xs font-bold text-slate-700 border-b min-w-[120px]">
                    LOCAL <FilterInput val={filtros.local} onChange={(v:any) => setFiltros(p => ({...p, local: v}))} ph="..."/>
                </th>
                <th className="px-4 py-2 text-xs font-bold text-slate-700 border-b min-w-[140px]">
                    GTIN / LOTE <FilterInput val={filtros.gtin} onChange={(v:any) => setFiltros(p => ({...p, gtin: v}))} ph="..."/>
                </th>
                <th className="px-4 py-2 text-xs font-bold text-slate-700 border-b w-1/3">
                    DESCRIÇÃO <FilterInput val={filtros.desc} onChange={(v:any) => setFiltros(p => ({...p, desc: v}))} ph="..."/>
                </th>
                
                {/* Colunas Dinamicas */}
                {modoAuditoria ? (
                    <th className="px-2 py-2 text-center text-xs font-bold text-purple-800 bg-purple-50 border-b w-24">AUDITORIA</th>
                ) : (
                    <>
                        <th className="px-2 py-2 text-center text-xs font-bold text-blue-800 bg-blue-50 border-b w-24">QTD 1</th>
                        <th className="px-2 py-2 text-center text-xs font-bold text-indigo-800 bg-indigo-50 border-b w-24">QTD 2</th>
                    </>
                )}
                
                <th className="px-2 py-2 text-center text-xs font-bold text-green-800 bg-green-50 border-b w-24">SISTEMA</th>
                <th className="px-4 py-2 text-xs font-bold text-slate-700 border-b min-w-[150px]">
                    STATUS <FilterInput val={filtros.status} onChange={(v:any) => setFiltros(p => ({...p, status: v}))} ph="..."/>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {dadosFiltrados.map((item) => (
                <tr key={item.idTemp} className={`text-xs transition-colors ${
                    item.status === 'OK' ? 'hover:bg-slate-50' : 
                    item.status === 'ALERTA LOCAL' ? 'bg-yellow-50 hover:bg-yellow-100' : 
                    'bg-red-50 hover:bg-red-100'
                }`}>
                  <td className="px-4 py-3 font-medium">{item.local}</td>
                  
                  <td className="px-4 py-3">
                    <div className="font-bold">{item.gtin}</div>
                    <div className="text-[10px] text-slate-500">{item.lote}</div>
                  </td>
                  
                  <td className="px-4 py-3 truncate max-w-[300px]" title={item.desc}>
                    {item.desc}
                  </td>
                  
                  {modoAuditoria ? (
                    <td className="px-2 py-3 text-center font-bold text-purple-700 bg-purple-50/30">
                        {item.qtdAudit}
                    </td>
                  ) : (
                    <>
                        <td className="px-2 py-3 text-center font-bold text-blue-700 bg-blue-50/30">
                            {item.qtd1}
                        </td>
                        <td className="px-2 py-3 text-center font-bold text-indigo-700 bg-indigo-50/30">
                            {item.qtd2}
                        </td>
                    </>
                  )}
                  
                  <td className="px-2 py-3 text-center font-bold text-green-700 bg-green-50/30">
                    {item.qtdSys}
                  </td>
                  
                  <td className="px-4 py-3">
                    <span className={`flex items-center w-fit px-2 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${
                        item.status === 'ALERTA LOCAL' ? 'text-yellow-700 bg-yellow-100 border-yellow-200' : 
                        item.status === 'OK' ? 'text-green-700 bg-green-100 border-green-200' : 
                        'text-red-700 bg-red-100 border-red-200'
                    }`}>
                        {item.status === 'OK' ? (
                            <CheckCircle size={12} className="mr-1" />
                        ) : item.status === 'ALERTA LOCAL' ? (
                            <ArrowRightLeft size={12} className="mr-1" />
                        ) : (
                            <AlertTriangle size={12} className="mr-1" />
                        )}
                        {item.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 bg-slate-50">
            <Filter size={48} className="mb-4 text-slate-300" />
            <p className="text-sm font-medium">Selecione o modo e processe os arquivos.</p>
          </div>
        )}
      </main>
    </div>
  );
}