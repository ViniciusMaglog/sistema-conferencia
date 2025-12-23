'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';

export default function HistoricoPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistorico = async () => {
    setLoading(true);
    // Busca da view que criamos
    const { data, error } = await supabase.from('view_historico_completo').select('*');
    if (error) {
        alert("Erro ao buscar histórico");
        console.error(error);
        return;
    }

    // Processar os dados para pivoteamento (Transformar linhas em colunas por rodada)
    const agrupado = new Map();

    data.forEach((row: any) => {
        const chave = `${row.localizacao}|${row.gtin}|${row.lote}`;
        if (!agrupado.has(chave)) {
            agrupado.set(chave, {
                id: row.id,
                local: row.localizacao,
                gtin: row.gtin,
                lote: row.lote,
                desc: row.descricao,
                sys: row.qtd_sistema,
                status: row.status_atual,
                contagens: {} // Vai guardar { 1: {qtd, user}, 2: {qtd, user} }
            });
        }
        const item = agrupado.get(chave);
        if (row.rodada) {
            item.contagens[row.rodada] = { qtd: row.qtd_contada, user: row.usuario };
        }
    });

    setItems(Array.from(agrupado.values()));
    setLoading(false);
  };

  useEffect(() => { fetchHistorico(); }, []);

  // --- FUNÇÃO DE EXPORTAÇÃO CORRIGIDA ---
  const baixarExcelGeral = () => {
    const flatData = items.map(i => {
        const row: any = {
            Local: i.local, GTIN: i.gtin, Lote: i.lote, Descricao: i.desc, Sistema: i.sys, Status: i.status
        };
        // Adiciona colunas dinamicamente até a rodada 6
        for(let r=1; r<=6; r++) {
            if(i.contagens[r]) {
                row[`R${r}_Qtd`] = i.contagens[r].qtd;
                row[`R${r}_User`] = i.contagens[r].user;
            }
        }
        return row;
    });

    // CORREÇÃO: Cria Sheet -> Cria Book -> Append -> Write
    const ws = XLSX.utils.json_to_sheet(flatData); 
    const wb = XLSX.utils.book_new();              
    XLSX.utils.book_append_sheet(wb, ws, "Histórico"); 
    XLSX.writeFile(wb, "Historico_Completo.xlsx"); 
  };

  return (
    <div className="min-h-screen bg-slate-100 p-8 text-slate-800">
        <div className="max-w-[95%] mx-auto">
            <header className="mb-6 flex justify-between items-center">
                <div className="flex items-center gap-4">
                    <Link href="/" className="bg-white p-2 rounded-full shadow hover:bg-slate-50"><ArrowLeft /></Link>
                    <h1 className="text-3xl font-bold text-slate-900">Histórico de Contagens</h1>
                </div>
                <div className="flex gap-2">
                    <button onClick={fetchHistorico} className="p-2 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"><RefreshCw size={20}/></button>
                    <button onClick={baixarExcelGeral} className="bg-green-600 text-white px-4 py-2 rounded font-bold hover:bg-green-700">Baixar Tudo (Excel)</button>
                </div>
            </header>

            {loading ? <p>Carregando dados do banco...</p> : (
                <div className="bg-white rounded shadow border overflow-x-auto">
                    <table className="w-full text-sm text-left whitespace-nowrap">
                        <thead className="bg-slate-800 text-white uppercase font-bold sticky top-0">
                            <tr>
                                <th className="px-4 py-3 bg-slate-900 left-0 sticky z-10">Local</th>
                                <th className="px-4 py-3 bg-slate-900 left-20 sticky z-10">GTIN</th>
                                <th className="px-4 py-3">Lote</th>
                                <th className="px-4 py-3 bg-green-900">WMS</th>
                                {/* Colunas Dinâmicas */}
                                {[1,2,3,4,5,6].map(r => (
                                    <th key={r} className="px-4 py-3 text-center border-l border-slate-600">
                                        {r}ª Contagem
                                    </th>
                                ))}
                                <th className="px-4 py-3">Status Atual</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {items.map((item, idx) => (
                                <tr key={idx} className="hover:bg-slate-50">
                                    <td className="px-4 py-2 font-medium bg-white left-0 sticky">{item.local}</td>
                                    <td className="px-4 py-2 bg-white left-20 sticky">{item.gtin}</td>
                                    <td className="px-4 py-2">{item.lote}</td>
                                    <td className="px-4 py-2 font-bold text-green-700">{item.sys}</td>
                                    {[1,2,3,4,5,6].map(r => (
                                        <td key={r} className="px-4 py-2 text-center border-l border-slate-100">
                                            {item.contagens[r] ? (
                                                <div className="flex flex-col">
                                                    <span className="font-bold text-blue-700 text-lg">{item.contagens[r].qtd}</span>
                                                    <span className="text-[10px] text-slate-400">{item.contagens[r].user}</span>
                                                </div>
                                            ) : <span className="text-slate-200">-</span>}
                                        </td>
                                    ))}
                                    <td className="px-4 py-2 font-bold">{item.status}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    </div>
  );
}