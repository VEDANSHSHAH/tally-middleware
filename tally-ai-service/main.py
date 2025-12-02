from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import os
from dotenv import load_dotenv

# Import utilities and services
from utils.database import (
    get_vendors, 
    get_vendor_scores, 
    get_transactions, 
    get_outstanding_aging
)
from services.analytics import (
    detect_anomalies, 
    predict_cashflow, 
    analyze_payment_trends
)
from services.openai_service import (
    generate_vendor_insight,
    generate_cashflow_insight,
    answer_question
)
from routes import dashboard
from jobs.refresh_scheduler import start_scheduler, stop_scheduler

load_dotenv()

app = FastAPI(
    title="Tally AI Service",
    description="AI-powered analytics for Tally data",
    version="1.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard.router)

@app.on_event("startup")
async def startup_event():
    start_scheduler()
    print("✅ Background scheduler started")


@app.on_event("shutdown")
async def shutdown_event():
    stop_scheduler()
    print("Scheduler stopped")

@app.get("/")
async def root():
    return {
        "service": "Tally AI Service",
        "status": "running",
        "version": "1.0.0",
        "endpoints": [
            "/ai/insights",
            "/ai/vendor-insights",
            "/ai/cashflow-insight",
            "/ai/anomalies",
            "/ai/predictions",
            "/ai/trends",
            "/ai/chat"
        ]
    }

@app.get("/ai/insights")
async def get_all_insights():
    """Get all AI insights"""
    try:
        # Get data
        vendors = get_vendors()
        vendor_scores = get_vendor_scores()
        transactions = get_transactions()
        aging = get_outstanding_aging()
        
        # Generate insights
        insights = []
        
        # Vendor insights
        if vendor_scores:
            for vendor in vendor_scores[:3]:  # Top 3 vendors
                insight_text = await generate_vendor_insight(vendor)
                insights.append({
                    "type": "vendor_performance",
                    "title": f"Vendor: {vendor['vendor_name']}",
                    "description": insight_text,
                    "severity": vendor['risk_level'],
                    "data": {
                        "vendor_name": vendor['vendor_name'],
                        "score": float(vendor['overall_score']),
                        "balance": float(vendor['current_balance'])
                    }
                })
        
        # Cash flow insight
        if aging and transactions:
            cashflow_text = await generate_cashflow_insight(aging, transactions)
            insights.append({
                "type": "cashflow_analysis",
                "title": "Cash Flow Analysis",
                "description": cashflow_text,
                "severity": "info",
                "data": {}
            })
        
        # Anomalies
        anomalies = detect_anomalies(transactions)
        if anomalies:
            insights.append({
                "type": "anomaly_detected",
                "title": f"{len(anomalies)} Anomalies Detected",
                "description": f"Found {len(anomalies)} unusual transactions",
                "severity": "high" if len(anomalies) > 3 else "medium",
                "data": {"count": len(anomalies), "anomalies": anomalies[:3]}
            })
        
        return {
            "success": True,
            "count": len(insights),
            "insights": insights
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai/vendor-insights")
async def get_vendor_insights():
    """Get AI insights for all vendors"""
    try:
        vendor_scores = get_vendor_scores()
        
        if not vendor_scores:
            return {
                "success": True,
                "message": "No vendor data available",
                "insights": []
            }
        
        insights = []
        for vendor in vendor_scores:
            insight_text = await generate_vendor_insight(vendor)
            insights.append({
                "vendor_id": vendor['vendor_id'],
                "vendor_name": vendor['vendor_name'],
                "score": float(vendor['overall_score']),
                "risk_level": vendor['risk_level'],
                "balance": float(vendor['current_balance']),
                "insight": insight_text
            })
        
        return {
            "success": True,
            "count": len(insights),
            "insights": insights
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai/cashflow-insight")
async def get_cashflow_insight():
    """Get AI-powered cash flow insight"""
    try:
        aging = get_outstanding_aging()
        transactions = get_transactions()
        
        if not aging and not transactions:
            return {
                "success": True,
                "message": "Insufficient data for cash flow analysis",
                "insight": None
            }
        
        insight_text = await generate_cashflow_insight(aging, transactions)
        
        return {
            "success": True,
            "insight": insight_text,
            "data": {
                "total_outstanding": sum([float(a.get('total_outstanding', 0)) for a in aging]),
                "transaction_count": len(transactions)
            }
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai/anomalies")
async def get_anomalies():
    """Detect anomalies in transactions"""
    try:
        transactions = get_transactions()
        
        if not transactions:
            return {
                "success": True,
                "message": "No transaction data available",
                "anomalies": []
            }
        
        anomalies = detect_anomalies(transactions)
        
        return {
            "success": True,
            "count": len(anomalies),
            "anomalies": anomalies
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai/predictions")
async def get_predictions():
    """Get cash flow predictions"""
    try:
        transactions = get_transactions()
        aging = get_outstanding_aging()
        
        if not transactions:
            return {
                "success": True,
                "message": "Insufficient data for predictions",
                "prediction": None
            }
        
        prediction = predict_cashflow(transactions, aging)
        
        return {
            "success": True,
            "prediction": prediction
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai/trends")
async def get_trends():
    """Analyze payment trends"""
    try:
        transactions = get_transactions()
        
        if not transactions:
            return {
                "success": True,
                "message": "No transaction data available",
                "trends": None
            }
        
        trends = analyze_payment_trends(transactions)
        
        return {
            "success": True,
            "trends": trends
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/ai/chat")
async def ai_chat(question: str):
    """Ask AI a question about your business data"""
    try:
        # Get context data
        vendors = get_vendors()
        transactions = get_transactions()
        
        context = {
            "vendors": vendors,
            "transactions": transactions
        }
        
        answer = await answer_question(question, context)
        
        return {
            "success": True,
            "question": question,
            "answer": answer
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    port = int(os.getenv('PORT', 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
