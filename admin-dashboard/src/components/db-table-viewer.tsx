"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";

interface ColumnInfo {
    column_name: string;
    data_type: string;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_nullable: string;
    column_default: string | null;
    is_primary_key: boolean;
}

interface TableWithColumns {
    table_name: string;
    table_schema: string;
    columns: ColumnInfo[];
    row_count: number;
}

interface TableData {
    data: any[];
    columns: string[];
}

function formatDataType(col: ColumnInfo): string {
    let type = col.data_type;
    
    if (col.character_maximum_length) {
        type += `(${col.character_maximum_length})`;
    } else if (col.numeric_precision !== null) {
        if (col.numeric_scale !== null && col.numeric_scale > 0) {
            type += `(${col.numeric_precision}, ${col.numeric_scale})`;
        } else {
            type += `(${col.numeric_precision})`;
        }
    }
    
    return type;
}

function formatValue(value: any): string {
    if (value === null || value === undefined) {
        return "NULL";
    }
    if (typeof value === "object") {
        return JSON.stringify(value);
    }
    return String(value);
}

export function DBTableViewer({ table }: { table: TableWithColumns }) {
    const [activeTab, setActiveTab] = useState<"columns" | "data">("columns");
    const [tableData, setTableData] = useState<TableData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchTableData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            console.log("Fetching data for table:", table.table_name);
            const response = await fetch(`/api/db/table/${table.table_name}`);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}: Failed to fetch table data`);
            }
            
            const data = await response.json();
            console.log("Data received:", data);
            setTableData(data);
        } catch (err: any) {
            console.error("Error in fetchTableData:", err);
            setError(err.message || "Failed to load table data");
        } finally {
            setLoading(false);
        }
    }, [table.table_name]);

    useEffect(() => {
        if (activeTab === "data" && tableData === null && !loading) {
            fetchTableData();
        }
    }, [activeTab, tableData, loading, fetchTableData]);

    return (
        <div className="border rounded-lg overflow-hidden">
            <div className="bg-gray-800 px-4 py-3 border-b">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <h2 className="text-lg font-semibold text-white">{table.table_name}</h2>
                        <p className="text-sm text-gray-400">Schema: {table.table_schema}</p>
                    </div>
                    <div className="text-sm text-gray-400">
                        {table.row_count} rows
                    </div>
                </div>
                <div className="flex gap-2 border-t border-gray-700 pt-3">
                    <button
                        onClick={() => setActiveTab("columns")}
                        className={`px-4 py-2 text-sm font-medium rounded transition ${
                            activeTab === "columns"
                                ? "bg-blue-600 text-white"
                                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                        }`}
                    >
                        Columns
                    </button>
                    <button
                        onClick={() => setActiveTab("data")}
                        className={`px-4 py-2 text-sm font-medium rounded transition ${
                            activeTab === "data"
                                ? "bg-blue-600 text-white"
                                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                        }`}
                    >
                        Data
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto">
                {activeTab === "columns" ? (
                    <table className="w-full">
                        <thead className="bg-gray-800 border-b">
                            <tr>
                                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Column Name</th>
                                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Data Type</th>
                                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Nullable</th>
                                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Default</th>
                                <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Primary Key</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-700">
                            {table.columns.map((col, idx) => (
                                <tr key={col.column_name} className={idx % 2 === 0 ? "bg-gray-900" : "bg-gray-800"}>
                                    <td className="px-4 py-3 text-sm text-white font-mono">
                                        {col.column_name}
                                        {col.is_primary_key && (
                                            <span className="ml-2 text-xs text-blue-400">PK</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-300 font-mono">
                                        {formatDataType(col)}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-300">
                                        {col.is_nullable === "YES" ? (
                                            <span className="text-yellow-400">NULL</span>
                                        ) : (
                                            <span className="text-red-400">NOT NULL</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-400 font-mono">
                                        {col.column_default ? (
                                            <span className="text-green-400">{col.column_default}</span>
                                        ) : (
                                            <span className="text-gray-500">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-gray-300">
                                        {col.is_primary_key ? (
                                            <span className="text-blue-400">✓</span>
                                        ) : (
                                            <span className="text-gray-500">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div>
                        {loading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                                <span className="ml-2 text-gray-400">Loading data...</span>
                            </div>
                        ) : error ? (
                            <div className="px-4 py-8 text-center text-red-400">
                                {error}
                            </div>
                        ) : tableData ? (
                            tableData.data.length > 0 ? (
                                <table className="w-full">
                                    <thead className="bg-gray-800 border-b">
                                        <tr>
                                            {tableData.columns.map((col) => (
                                                <th
                                                    key={col}
                                                    className="px-4 py-3 text-left text-sm font-medium text-gray-300"
                                                >
                                                    {col}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {tableData.data.map((row, rowIdx) => (
                                            <tr
                                                key={rowIdx}
                                                className={rowIdx % 2 === 0 ? "bg-gray-900" : "bg-gray-800"}
                                            >
                                                {tableData.columns.map((col) => (
                                                    <td
                                                        key={col}
                                                        className="px-4 py-3 text-sm text-gray-300 font-mono"
                                                    >
                                                        {formatValue(row[col])}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <div className="px-4 py-8 text-center text-gray-400">
                                    No data available (table is empty)
                                </div>
                            )
                        ) : null}
                    </div>
                )}
            </div>
        </div>
    );
}

