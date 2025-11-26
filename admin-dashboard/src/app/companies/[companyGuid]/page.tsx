import { db } from "@/lib/db";
import { companies } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { CompanyTableViewer } from "@/components/company-table-viewer";
import { pool } from "@/lib/db";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

interface TableWithColumns {
    table_name: string;
    row_count: number;
    columns: any[];
}

async function getCompany(companyGuid: string) {
    const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.companyGuid, companyGuid))
        .limit(1);
    
    return company;
}

async function getCompanyTables(companyGuid: string): Promise<TableWithColumns[]> {
    try {
        // Get all tables that have company_guid column
        const tablesWithCompanyGuid = await pool.query(`
            SELECT DISTINCT table_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
            AND column_name = 'company_guid'
            AND table_name IN (
                'vendors', 'customers', 'transactions', 
                'vendor_scores', 'outstanding_aging', 'payment_cycles'
            )
            ORDER BY table_name;
        `);

        const tablesData: TableWithColumns[] = [];

        for (const table of tablesWithCompanyGuid.rows) {
            const tableName = table.table_name;
            
            // Get row count for this company
            const countResult = await pool.query(
                `SELECT COUNT(*) as count FROM "${tableName}" WHERE company_guid = $1`,
                [companyGuid]
            );
            
            const rowCount = parseInt(countResult.rows[0].count, 10);
            
            // Get column information
            const columnsResult = await pool.query(`
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
            `, [tableName]);

            tablesData.push({
                table_name: tableName,
                row_count: rowCount,
                columns: columnsResult.rows.map(col => ({
                    column_name: col.column_name,
                    data_type: col.data_type,
                    character_maximum_length: col.character_maximum_length,
                    numeric_precision: col.numeric_precision,
                    numeric_scale: col.numeric_scale,
                    is_nullable: col.is_nullable,
                    column_default: col.column_default,
                    is_primary_key: col.is_primary_key,
                })),
            });
        }

        return tablesData;
    } catch (error) {
        console.error("Error fetching company tables:", error);
        throw error;
    }
}

export default async function CompanyDetailPage({
    params,
}: {
    params: Promise<{ companyGuid: string }> | { companyGuid: string };
}) {
    const resolvedParams = params instanceof Promise ? await params : params;
    const companyGuid = resolvedParams.companyGuid;
    
    const company = await getCompany(companyGuid);
    const tables = await getCompanyTables(companyGuid);

    if (!company) {
        return (
            <div className="container mx-auto py-10">
                <h1 className="text-2xl font-bold mb-5">Company Not Found</h1>
                <Link href="/companies" className="text-blue-400 hover:underline">
                    ← Back to Companies
                </Link>
            </div>
        );
    }

    return (
        <div className="container mx-auto py-10">
            <div className="mb-6">
                <Link 
                    href="/companies" 
                    className="inline-flex items-center text-blue-400 hover:text-blue-300 mb-4"
                >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back to Companies
                </Link>
                <h1 className="text-2xl font-bold mb-2">{company.companyName}</h1>
                <div className="text-sm text-gray-400 space-y-1">
                    <p>GUID: {company.companyGuid}</p>
                    {company.tallyCompanyName && <p>Tally Name: {company.tallyCompanyName}</p>}
                    <p>Verified: {company.verified ? <span className="text-green-400">Yes</span> : <span className="text-red-400">No</span>}</p>
                </div>
            </div>
            
            <h2 className="text-xl font-semibold mb-4">Company Database Tables</h2>
            <p className="text-gray-400 mb-6">View all database tables and data for this company</p>
            
            <div className="space-y-8">
                {tables.map((table) => (
                    <CompanyTableViewer 
                        key={table.table_name} 
                        table={table} 
                        companyGuid={companyGuid}
                    />
                ))}
            </div>
        </div>
    );
}

