import numpy as np
from datetime import datetime, timedelta

def detect_anomalies(transactions):
    """Detect anomalies in transactions"""
    
    if not transactions or len(transactions) < 5:
        return []
    
    # Extract amounts
    amounts = [float(t.get('amount', 0)) for t in transactions if t.get('amount')]
    
    if not amounts:
        return []
    
    # Calculate statistics
    mean_amount = np.mean(amounts)
    std_amount = np.std(amounts)
    
    anomalies = []
    
    # Find outliers (> 2 standard deviations)
    for idx, t in enumerate(transactions):
        amount = float(t.get('amount', 0))
        if abs(amount - mean_amount) > 2 * std_amount and std_amount > 0:
            deviation_pct = ((amount - mean_amount) / mean_amount) * 100 if mean_amount > 0 else 0
            
            anomalies.append({
                'type': 'unusual_amount',
                'transaction_id': t.get('id'),
                'voucher_number': t.get('voucher_number'),
                'amount': amount,
                'expected_amount': round(mean_amount, 2),
                'deviation_percentage': round(deviation_pct, 2),
                'severity': 'high' if abs(deviation_pct) > 300 else 'medium',
                'message': f"Amount ₹{amount:,.0f} is {abs(deviation_pct):.0f}% different from average"
            })
    
    return anomalies

def predict_cashflow(transactions, aging_data):
    """Predict next month's cash flow"""
    
    if not transactions or len(transactions) < 3:
        return {
            'predicted_amount': 0,
            'confidence': 0,
            'message': 'Insufficient data for prediction'
        }
    
    # Get recent transactions (last 30)
    recent = transactions[:30] if len(transactions) > 30 else transactions
    amounts = [float(t.get('amount', 0)) for t in recent if t.get('amount')]
    
    if amounts:
        avg_daily = np.mean(amounts)
        predicted_monthly = avg_daily * 30
        confidence = min(len(recent) / 30, 1.0) * 100
        
        return {
            'predicted_amount': round(predicted_monthly, 2),
            'confidence': round(confidence, 2),
            'based_on_days': len(recent),
            'message': f'Predicted monthly cashflow: ₹{predicted_monthly:,.0f}'
        }
    
    return {
        'predicted_amount': 0,
        'confidence': 0,
        'message': 'Unable to predict cashflow'
    }

def analyze_payment_trends(transactions):
    """Analyze payment trends over time"""
    
    if not transactions or len(transactions) < 2:
        return {'trend': 'stable', 'message': 'Insufficient data'}
    
    # Split into recent and previous halves
    mid = len(transactions) // 2
    recent = transactions[:mid]
    previous = transactions[mid:]
    
    recent_amounts = [float(t.get('amount', 0)) for t in recent if t.get('amount')]
    previous_amounts = [float(t.get('amount', 0)) for t in previous if t.get('amount')]
    
    if recent_amounts and previous_amounts:
        recent_avg = np.mean(recent_amounts)
        previous_avg = np.mean(previous_amounts)
        
        if previous_avg > 0:
            change_pct = ((recent_avg - previous_avg) / previous_avg) * 100
            trend = 'increasing' if change_pct > 5 else ('decreasing' if change_pct < -5 else 'stable')
            
            return {
                'trend': trend,
                'change_percentage': round(change_pct, 2),
                'current_average': float(recent_avg),
                'previous_average': float(previous_avg),
                'message': f'Payments are {trend} by {abs(change_pct):.1f}%'
            }
    
    return {'trend': 'stable', 'message': 'Insufficient data for trend analysis'}    