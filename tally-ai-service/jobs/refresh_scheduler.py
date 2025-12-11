"""
TALLY AI - REFRESH SCHEDULER
==============================
Periodically refreshes AI summary tables with correct calculations.

Fixes applied:
1. Populates ai.customer_summary (was missing)
2. Populates ai.business_overview with correct totals
3. Uses correct outstanding formula: opening + sales - receipts
4. Filters out Cash/Bank from customers
5. Updates formatted columns for AI
6. Calculates advances separately from receivables

Run: every 5 minutes or on-demand after sync
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler
import asyncpg
import os
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def get_db_pool():
    return await asyncpg.create_pool(
        os.getenv("DATABASE_URL"),
        min_size=2,
        max_size=10,
    )


# -----------------------------------------------------------------------------
# REFRESH AI CUSTOMER SUMMARY
# -----------------------------------------------------------------------------

async def refresh_customer_summary(company_guid: str):
    """
    Populate ai.customer_summary from vouchers and ledgers.

    Critical:
    - Outstanding = opening_balance + sales - receipts (NOT ledger.current_balance)
    - Exclude Cash, Bank, Petty Cash from customers
    """
    pool = await get_db_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                period_start = await conn.fetchval(
                    """
                    SELECT COALESCE(
                        (SELECT MIN(date) FROM vouchers WHERE company_guid = $1),
                        DATE_TRUNC('year', CURRENT_DATE)
                    )
                    """,
                    company_guid,
                )

                period_end = await conn.fetchval(
                    """
                    SELECT COALESCE(
                        (SELECT MAX(date) FROM vouchers WHERE company_guid = $1),
                        CURRENT_DATE
                    )
                    """,
                    company_guid,
                )

                await conn.execute(
                    """
                    DELETE FROM ai.customer_summary
                    WHERE company_guid = $1
                    """,
                    company_guid,
                )

                await conn.execute(
                    """
                    INSERT INTO ai.customer_summary (
                        company_guid,
                        period_start,
                        period_end,
                        customer_name,
                        customer_guid,
                        opening_balance,
                        sales_value,
                        sales_count,
                        receipts_value,
                        receipts_count,
                        outstanding_amount,
                        current_balance,
                        average_order_value,
                        sales_rank,
                        outstanding_rank,
                        outstanding_formatted,
                        sales_formatted,
                        balance_status
                    )
                    SELECT
                        $1 AS company_guid,
                        $2 AS period_start,
                        $3 AS period_end,
                        l.name AS customer_name,
                        l.guid AS customer_guid,
                        COALESCE(l.opening_balance, 0) AS opening_balance,
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Sales', 'SALES', 'Invoice', 'Sales Invoice')
                              AND v.is_cancelled = FALSE
                        ), 0) AS sales_value,
                        COALESCE((
                            SELECT COUNT(*)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Sales', 'SALES', 'Invoice', 'Sales Invoice')
                              AND v.is_cancelled = FALSE
                        ), 0) AS sales_count,
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Receipt', 'RECEIPT', 'Payment Received')
                              AND v.is_cancelled = FALSE
                        ), 0) AS receipts_value,
                        COALESCE((
                            SELECT COUNT(*)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Receipt', 'RECEIPT', 'Payment Received')
                              AND v.is_cancelled = FALSE
                        ), 0) AS receipts_count,
                        COALESCE(l.opening_balance, 0) +
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Sales', 'SALES', 'Invoice', 'Sales Invoice')
                              AND v.is_cancelled = FALSE
                        ), 0) -
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Receipt', 'RECEIPT', 'Payment Received')
                              AND v.is_cancelled = FALSE
                        ), 0) AS outstanding_amount,
                        COALESCE(l.opening_balance, 0) +
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Sales', 'SALES', 'Invoice', 'Sales Invoice')
                              AND v.is_cancelled = FALSE
                        ), 0) -
                        COALESCE((
                            SELECT SUM(v.total_amount)
                            FROM vouchers v
                            WHERE v.party_ledger_id = l.id
                              AND v.voucher_type IN ('Receipt', 'RECEIPT', 'Payment Received')
                              AND v.is_cancelled = FALSE
                        ), 0) AS current_balance,
                        CASE
                            WHEN (SELECT COUNT(*)
                                  FROM vouchers v
                                  WHERE v.party_ledger_id = l.id
                                    AND v.voucher_type IN ('Sales', 'SALES', 'Invoice')
                                    AND v.is_cancelled = FALSE) > 0
                            THEN (SELECT SUM(v.total_amount)
                                  FROM vouchers v
                                  WHERE v.party_ledger_id = l.id
                                    AND v.voucher_type IN ('Sales', 'SALES', 'Invoice')
                                    AND v.is_cancelled = FALSE) /
                                 (SELECT COUNT(*)
                                  FROM vouchers v
                                  WHERE v.party_ledger_id = l.id
                                    AND v.voucher_type IN ('Sales', 'SALES', 'Invoice')
                                    AND v.is_cancelled = FALSE)
                            ELSE 0
                        END AS average_order_value,
                        0 AS sales_rank,
                        0 AS outstanding_rank,
                        CASE
                            WHEN ABS(COALESCE(l.opening_balance, 0) +
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0)
                            ) >= 10000000 THEN '₹' || ROUND((COALESCE(l.opening_balance, 0) +
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0)
                            ) / 10000000.0, 2) || ' Cr'
                            WHEN ABS(COALESCE(l.opening_balance, 0) +
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0)
                            ) >= 100000 THEN '₹' || ROUND((COALESCE(l.opening_balance, 0) +
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0)
                            ) / 100000.0, 2) || ' L'
                            ELSE '₹' || ROUND(COALESCE(l.opening_balance, 0) +
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                     COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0)
                            , 0)
                        END AS outstanding_formatted,
                        '₹0' AS sales_formatted,
                        CASE
                            WHEN COALESCE(l.opening_balance, 0) +
                                 COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                 COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0) > 0
                            THEN 'OWES_MONEY'
                            WHEN COALESCE(l.opening_balance, 0) +
                                 COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Sales', 'SALES', 'Invoice') AND v.is_cancelled = FALSE), 0) -
                                 COALESCE((SELECT SUM(v.total_amount) FROM vouchers v WHERE v.party_ledger_id = l.id AND v.voucher_type IN ('Receipt', 'RECEIPT') AND v.is_cancelled = FALSE), 0) < 0
                            THEN 'HAS_ADVANCE'
                            ELSE 'SETTLED'
                        END AS balance_status
                    FROM ledgers l
                    WHERE l.company_guid = $1
                      AND l.parent_group = 'Sundry Debtors'
                      AND l.active = TRUE
                      AND l.name IS NOT NULL
                      AND l.name != ''
                      AND LOWER(l.name) NOT IN ('cash', 'bank', 'cash in hand', 'petty cash', 'bank account', 'bank accounts')
                    """,
                    company_guid,
                    period_start,
                    period_end,
                )

                await conn.execute(
                    """
                    WITH ranked AS (
                        SELECT
                            customer_guid,
                            ROW_NUMBER() OVER (PARTITION BY company_guid ORDER BY sales_value DESC) AS s_rank,
                            ROW_NUMBER() OVER (PARTITION BY company_guid ORDER BY outstanding_amount DESC) AS o_rank
                        FROM ai.customer_summary
                        WHERE company_guid = $1
                    )
                    UPDATE ai.customer_summary cs
                    SET
                        sales_rank = r.s_rank,
                        outstanding_rank = r.o_rank
                    FROM ranked r
                    WHERE cs.customer_guid = r.customer_guid
                      AND cs.company_guid = $1
                    """,
                    company_guid,
                )

                await conn.execute(
                    """
                    UPDATE ai.customer_summary
                    SET sales_formatted =
                        CASE
                            WHEN sales_value >= 10000000 THEN '₹' || ROUND(sales_value / 10000000.0, 2) || ' Cr'
                            WHEN sales_value >= 100000 THEN '₹' || ROUND(sales_value / 100000.0, 2) || ' L'
                            WHEN sales_value >= 1000 THEN '₹' || ROUND(sales_value / 1000.0, 1) || ' K'
                            ELSE '₹' || ROUND(sales_value, 0)
                        END
                    WHERE company_guid = $1
                    """,
                    company_guid,
                )

                logger.info("Customer summary refreshed for %s", company_guid)
    except Exception as exc:
        logger.error("Failed to refresh customer summary: %s", str(exc))
        raise
    finally:
        await pool.close()


# -----------------------------------------------------------------------------
# REFRESH BUSINESS OVERVIEW
# -----------------------------------------------------------------------------

async def refresh_business_overview(company_guid: str):
    """Update ai.business_overview with correct totals from customer_summary."""
    pool = await get_db_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE ai.business_overview bo
                    SET
                        total_receivables = COALESCE((
                            SELECT SUM(outstanding_amount)
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                              AND cs.outstanding_amount > 0
                        ), 0),
                        total_advances = COALESCE((
                            SELECT ABS(SUM(outstanding_amount))
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                              AND cs.outstanding_amount < 0
                        ), 0),
                        total_customers = COALESCE((
                            SELECT COUNT(DISTINCT customer_name)
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        ), 0),
                        total_sales = COALESCE((
                            SELECT SUM(sales_value)
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        ), 0),
                        total_receipts = COALESCE((
                            SELECT SUM(receipts_value)
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        ), 0),
                        total_sales_formatted = (
                            SELECT
                                CASE
                                    WHEN SUM(sales_value) >= 10000000 THEN '₹' || ROUND(SUM(sales_value) / 10000000.0, 2) || ' Cr'
                                    WHEN SUM(sales_value) >= 100000 THEN '₹' || ROUND(SUM(sales_value) / 100000.0, 2) || ' L'
                                    ELSE '₹' || ROUND(SUM(sales_value), 0)
                                END
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        ),
                        total_receivables_formatted = (
                            SELECT
                                CASE
                                    WHEN SUM(CASE WHEN outstanding_amount > 0 THEN outstanding_amount ELSE 0 END) >= 10000000
                                        THEN '₹' || ROUND(SUM(CASE WHEN outstanding_amount > 0 THEN outstanding_amount ELSE 0 END) / 10000000.0, 2) || ' Cr'
                                    WHEN SUM(CASE WHEN outstanding_amount > 0 THEN outstanding_amount ELSE 0 END) >= 100000
                                        THEN '₹' || ROUND(SUM(CASE WHEN outstanding_amount > 0 THEN outstanding_amount ELSE 0 END) / 100000.0, 2) || ' L'
                                    ELSE '₹' || ROUND(COALESCE(SUM(CASE WHEN outstanding_amount > 0 THEN outstanding_amount ELSE 0 END), 0), 0)
                                END
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        ),
                        total_advances_formatted = (
                            SELECT
                                CASE
                                    WHEN ABS(SUM(CASE WHEN outstanding_amount < 0 THEN outstanding_amount ELSE 0 END)) >= 10000000
                                        THEN '₹' || ROUND(ABS(SUM(CASE WHEN outstanding_amount < 0 THEN outstanding_amount ELSE 0 END)) / 10000000.0, 2) || ' Cr'
                                    WHEN ABS(SUM(CASE WHEN outstanding_amount < 0 THEN outstanding_amount ELSE 0 END)) >= 100000
                                        THEN '₹' || ROUND(ABS(SUM(CASE WHEN outstanding_amount < 0 THEN outstanding_amount ELSE 0 END)) / 100000.0, 2) || ' L'
                                    ELSE '₹' || ROUND(COALESCE(ABS(SUM(CASE WHEN outstanding_amount < 0 THEN outstanding_amount ELSE 0 END)), 0), 0)
                                END
                            FROM ai.customer_summary cs
                            WHERE cs.company_guid = bo.company_guid
                        )
                    WHERE bo.company_guid = $1
                    """,
                    company_guid,
                )

                logger.info("Business overview updated for %s", company_guid)
    except Exception as exc:
        logger.error("Failed to update business overview: %s", str(exc))
        raise
    finally:
        await pool.close()


# -----------------------------------------------------------------------------
# REFRESH DASHBOARD METRICS
# -----------------------------------------------------------------------------

async def refresh_dashboard_metrics(company_guid: str):
    """Update dashboard_metrics with correct values."""
    pool = await get_db_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE public.dashboard_metrics dm
                    SET
                        total_receivable = COALESCE((
                            SELECT SUM(total_receivables)
                            FROM ai.business_overview bo
                            WHERE bo.company_guid = dm.company_guid
                        ), 0),
                        customer_count = COALESCE((
                            SELECT SUM(total_customers)
                            FROM ai.business_overview bo
                            WHERE bo.company_guid = dm.company_guid
                        ), 0),
                        calculated_at = NOW()
                    WHERE dm.company_guid = $1
                    """,
                    company_guid,
                )

                await conn.execute(
                    """
                    UPDATE public.dashboard_metrics
                    SET total_receivable = 0
                    WHERE company_guid = $1
                      AND (total_receivable::text = 'NaN' OR total_receivable IS NULL)
                    """,
                    company_guid,
                )

                logger.info("Dashboard metrics updated for %s", company_guid)
    except Exception as exc:
        logger.error("Failed to update dashboard metrics: %s", str(exc))
        raise
    finally:
        await pool.close()


# -----------------------------------------------------------------------------
# MAIN REFRESH FUNCTION
# -----------------------------------------------------------------------------

async def refresh_company_ai_data(company_guid: str):
    """
    Complete refresh of all AI data for a company.

    Order:
    1. Customer summary (from vouchers)
    2. Business overview (from customer summary)
    3. Dashboard metrics (from business overview)
    """
    logger.info("Starting AI refresh for %s", company_guid)

    try:
        await refresh_customer_summary(company_guid)
        await refresh_business_overview(company_guid)
        await refresh_dashboard_metrics(company_guid)
        logger.info("AI refresh complete for %s", company_guid)
    except Exception as exc:
        logger.error("AI refresh failed for %s: %s", company_guid, str(exc))
        raise


async def refresh_all_companies():
    """Refresh AI data for all active companies."""
    logger.info("Starting AI refresh for all companies")

    pool = await get_db_pool()
    try:
        async with pool.acquire() as conn:
            companies = await conn.fetch(
                """
                SELECT company_guid
                FROM companies
                WHERE active = TRUE
                """
            )

            logger.info("Found %s active companies", len(companies))

            for company in companies:
                try:
                    await refresh_company_ai_data(company["company_guid"])
                except Exception as exc:
                    logger.error(
                        "Failed to refresh %s: %s",
                        company["company_guid"],
                        str(exc),
                    )

            logger.info("AI refresh completed for all companies")
    finally:
        await pool.close()


# -----------------------------------------------------------------------------
# SCHEDULER
# -----------------------------------------------------------------------------

scheduler = AsyncIOScheduler()


def start_scheduler():
    scheduler.add_job(
        refresh_all_companies,
        "interval",
        minutes=5,
        id="refresh_ai_data",
        replace_existing=True,
    )

    scheduler.add_job(
        refresh_all_companies,
        "date",
        run_date=datetime.now(),
        id="refresh_ai_data_startup",
    )

    scheduler.start()
    logger.info("AI refresh scheduler started (runs every 5 minutes)")


def stop_scheduler():
    scheduler.shutdown()
    logger.info("Scheduler stopped")
