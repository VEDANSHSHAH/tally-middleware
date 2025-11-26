import { pool } from "@/lib/db";
import { DBTableViewer } from "@/components/db-table-viewer";

interface TableInfo {
    table_name: string;
    table_schema: string;
}

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

async function getTables(): Promise<TableWithColumns[]> {
    try {
        // Get all tables from public schema
        const tablesResult = await pool.query<TableInfo>(`
            SELECT table_name, table_schema
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
            ORDER BY table_name;
        `);

        const tablesWithColumns: TableWithColumns[] = [];

        for (const table of tablesResult.rows) {
            // Get column information
            const columnsResult = await pool.query<ColumnInfo & { is_primary_key: boolean }>(`
                SELECT 
                    c.column_name,
                    c.data_type,
                    c.character_maximum_length,
                    c.numeric_precision,
                    c.numeric_scale,
                    c.is_nullable,
                    c.column_default,
                    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
                FROM information_schema.columns c
                LEFT JOIN (
                    SELECT ku.table_schema, ku.table_name, ku.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage ku
                        ON tc.constraint_name = ku.constraint_name
                        AND tc.table_schema = ku.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                ) pk ON c.table_schema = pk.table_schema
                    AND c.table_name = pk.table_name
                    AND c.column_name = pk.column_name
                WHERE c.table_schema = 'public'
                    AND c.table_name = $1
                ORDER BY c.ordinal_position;
            `, [table.table_name]);

            // Get row count
            const countResult = await pool.query<{ count: string }>(`
                SELECT COUNT(*) as count FROM "${table.table_name}";
            `);

            tablesWithColumns.push({
                table_name: table.table_name,
                table_schema: table.table_schema,
                columns: columnsResult.rows.map(col => ({
                    ...col,
                    is_primary_key: col.is_primary_key,
                })),
                row_count: parseInt(countResult.rows[0].count, 10),
            });
        }

        return tablesWithColumns;
    } catch (error) {
        console.error("Error fetching tables:", error);
        throw error;
    }
}

export default async function DBPage() {
    const tables = await getTables();

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-2xl font-bold mb-5">Database Tables</h1>
            <p className="text-gray-400 mb-6">View all tables and their specifications from Neon database</p>
            
            <div className="space-y-8">
                {tables.map((table) => (
                    <DBTableViewer key={table.table_name} table={table} />
                ))}
            </div>
        </div>
    );
}

