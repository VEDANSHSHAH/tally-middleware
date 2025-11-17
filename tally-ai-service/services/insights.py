from typing import List, Dict
import statistics

def generate_risk_insights(vendor_scores: List[Dict]) -> List[Dict]:
    """Generate risk insights from vendor scores"""
    insights = []
    
    if not vendor_scores:
        return insights
    
    # High risk vendors
    high_risk = [v for v in vendor_scores if v.get('risk_level') == 'high']
    if high_risk:
        insights.append({
            "type": "high_risk_vendors",
            "severity": "high",
            "title": f"{len(high_risk)} High Risk Vendors",
            "message": f"You have {len(high_risk)} vendors with high risk scores. Consider reviewing payment terms.",
            "vendors": [v['vendor_name'] for v in high_risk]
        })
    
    # Low score vendors
    low_score = [v for v in vendor_scores if float(v.get('overall_score', 100)) < 40]
    if low_score:
        insights.append({
            "type": "low_performance_vendors",
            "severity": "medium",
            "title": f"{len(low_score)} Underperforming Vendors",
            "message": "Some vendors have low performance scores. Review their reliability.",
            "vendors": [v['vendor_name'] for v in low_score]
        })
    
    return insights

def generate_aging_insights(aging_data: List[Dict]) -> List[Dict]:
    """Generate insights from aging data"""
    insights = []
    
    if not aging_data:
        return insights
    
    total_overdue = sum([
        float(a.get('current_61_90_days', 0)) + 
        float(a.get('current_over_90_days', 0)) 
        for a in aging_data
    ])
    
    if total_overdue > 0:
        insights.append({
            "type": "overdue_payments",
            "severity": "high",
            "title": "Overdue Payments Detected",
            "message": f"₹{total_overdue:,.0f} in payments are overdue (60+ days)",
            "amount": total_overdue
        })
    
    return insights

def generate_summary_insights(vendors, customers, transactions, vendor_scores, aging) -> Dict:
    """Generate overall business summary"""
    
    summary = {
        "overall_health": "good",
        "key_metrics": {},
        "recommendations": []
    }
    
    # Calculate health score
    health_factors = []
    
    # Vendor score health
    if vendor_scores:
        avg_score = statistics.mean([float(v.get('overall_score', 0)) for v in vendor_scores])
        health_factors.append(avg_score)
        summary['key_metrics']['avg_vendor_score'] = round(avg_score, 2)
    
    # Aging health
    if aging:
        total_outstanding = sum([float(a.get('total_outstanding', 0)) for a in aging])
        overdue = sum([
            float(a.get('current_over_90_days', 0)) 
            for a in aging
        ])
        overdue_pct = (overdue / total_outstanding * 100) if total_outstanding > 0 else 0
        health_factors.append(100 - overdue_pct)
        summary['key_metrics']['overdue_percentage'] = round(overdue_pct, 2)
    
    # Overall health
    if health_factors:
        overall_health_score = statistics.mean(health_factors)
        if overall_health_score >= 70:
            summary['overall_health'] = "good"
        elif overall_health_score >= 50:
            summary['overall_health'] = "moderate"
        else:
            summary['overall_health'] = "needs_attention"
    
    # Recommendations
    if summary['key_metrics'].get('overdue_percentage', 0) > 20:
        summary['recommendations'].append("Focus on collecting overdue payments")
    
    if summary['key_metrics'].get('avg_vendor_score', 100) < 60:
        summary['recommendations'].append("Review vendor performance and payment terms")
    
    return summary
