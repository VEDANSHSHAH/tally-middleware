import { pool } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ companyGuid: string }> | { companyGuid: string } }
) {
    try {
        const params = await (context.params instanceof Promise ? context.params : Promise.resolve(context.params));
        const companyGuid = params.companyGuid;
        
        console.log("Fetching tables for company:", companyGuid);
        
        // Validate company GUID format
        if (!/^[a-f0-9-]{36}$/i.test(companyGuid)) {
            return NextResponse.json(
                { error: "Invalid company GUID format" },
                { status: 400 }
            );
        }

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

        const tablesData: any[] = [];

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

        return NextResponse.json({ tables: tablesData });
    } catch (error: any) {
        console.error("Error fetching company tables:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch company tables" },
            { status: 500 }
        );
    }
}

