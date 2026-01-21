# Analytics & Tracking System

## Overview
This document explains how user interactions are tracked for salon owner analytics and business intelligence.

## What Gets Tracked

### 1. 👁️ Salon Views/Impressions
**When**: Every time a user opens a salon's details page  
**Where**: 
- Individual records: `salon_views` table
- Aggregated count: `salons.view_count`

**Data Captured**:
```javascript
{
  salon_id: UUID,
  user_id: UUID | null,      // null for anonymous views
  session_id: string,         // unique session identifier
  viewed_at: timestamp,
  source: 'app' | 'web',
  device_type: 'iOS 17.1' | 'Android 14'
}
```

**Endpoint**: `POST /api/salons/:salonId/track-view`

**Flutter Integration**:
```dart
// Automatically called in salon_details_page.dart initState()
TrackingService.trackSalonView(salonId);
```

---

### 2. ❤️ Favorites
**When**: User adds or removes a salon from favorites  
**Where**:
- Individual records: `user_favorites` table
- Aggregated count: `salons.favorite_count`

**Data Captured**:
```javascript
{
  user_id: UUID,
  salon_id: UUID,
  created_at: timestamp
}
```

**Endpoint**: `POST /api/salons/:salonId/track-favorite`  
**Body**: `{ action: 'add' | 'remove' }`

**Flutter Integration**:
```dart
// Automatically called in favorites_service.dart
// When adding:
TrackingService.trackSalonFavorite(salonId, true);
// When removing:
TrackingService.trackSalonFavorite(salonId, false);
```

---

### 3. 📅 Bookings
**When**: User creates a booking  
**Where**:
- Individual records: `bookings` table
- Aggregated count: `salons.booking_count`
- Last booking: `salons.last_booking_at`

**Data Captured**: Full booking details including service, staff, date, time, status

**Flutter Integration**:
```dart
// Automatically incremented in booking_controller.js
// after successful booking creation
await supabaseAdmin.rpc('increment_salon_booking_count', {
  salon_id_param: salon_id
});
```

---

### 4. ⭐ Reviews
**When**: User submits a review  
**Where**: `reviews` table

**Data Captured**:
```javascript
{
  booking_id: UUID,
  client_id: UUID,
  salon_id: UUID,
  staff_id: UUID | null,
  rating: 1-5,
  comment: string,
  is_visible: boolean,
  created_at: timestamp
}
```

**Aggregated Metrics**:
- `salons.rating_average`
- `salons.rating_count`

---

### 5. 💰 Revenue
**When**: Payment is completed  
**Where**: `payments` table

**Data Captured**:
```javascript
{
  booking_id: UUID,
  stripe_payment_intent_id: string,
  amount: decimal,
  currency: 'EUR',
  status: 'succeeded' | 'failed' | 'refunded',
  payment_method: jsonb,
  created_at: timestamp
}
```

---

## Trending Score Algorithm

**Formula**:
```
Trending Score = (Recent Views × 1) + (Recent Bookings × 10) + (Recent Favorites × 5)
```

**Recent = Last 7 days**

**Why This Weighting?**
- Views (1 point): Low intent, high volume
- Favorites (5 points): Medium intent, shows interest
- Bookings (10 points): High intent, actual conversion

**Update Frequency**: Should be run daily via cron job

**SQL Function**: `update_all_salons_trending_scores()`

---

## Analytics Dashboard Endpoints

### Get Salon Analytics
**Endpoint**: `GET /api/analytics?salonId={id}&period={days}`

**Parameters**:
- `salonId`: UUID (required)
- `period`: 7, 30, or 90 days (optional, default: 30)

**Returns**:
```javascript
{
  revenue: {
    total: 1250.00,
    currency: 'EUR',
    period: { start: '2025-01-01', end: '2025-01-30' },
    avgPerPayment: 62.50,
    timeline: [{ date: '2025-01-01', value: 125.00 }, ...]
  },
  bookings: {
    total: 45,
    completed: 30,
    confirmed: 10,
    pending: 3,
    cancelled: 2,
    timeline: [...]
  },
  views: {
    total: 1234,
    unique: 892,
    timeline: [...]
  },
  favorites: {
    total: 89,
    recentUsers: [{ id, firstName, lastName, avatarUrl, favoritedAt }, ...]
  },
  reviews: {
    avgRating: 4.5,
    total: 67,
    distribution: { 5: 40, 4: 20, 3: 5, 2: 1, 1: 1 }
  },
  salon: {
    trendingScore: 450.5,
    viewCount: 5678,
    bookingCount: 234,
    favoriteCount: 89
  }
}
```

### Get Reviews
**Endpoint**: `GET /api/analytics/reviews?salonId={id}&page={n}&limit={n}`

**Returns**: Paginated list of reviews with client details

---

## Database Functions

### Increment View Count
```sql
increment_salon_view_count(salon_id_param UUID)
```

### Increment/Decrement Favorite Count
```sql
increment_salon_favorite_count(salon_id_param UUID)
decrement_salon_favorite_count(salon_id_param UUID)
```

### Increment Booking Count
```sql
increment_salon_booking_count(salon_id_param UUID)
```

### Update Trending Scores
```sql
update_salon_trending_score(salon_id_param UUID)
update_all_salons_trending_scores()  -- Run via cron
```

---

## Anonymous Tracking

The system supports **anonymous tracking** for non-logged-in users:
- Views are tracked with `user_id = null`
- Session ID is used to deduplicate within sessions
- Device type and source are captured for analytics

**Privacy**: No personally identifiable information is collected for anonymous users.

---

## Error Handling

**Philosophy**: Tracking failures should NEVER block user actions

**Implementation**:
- All tracking calls are wrapped in try-catch
- Errors are logged but not thrown
- API returns 200 even on tracking failures
- Flutter tracking service silently fails

**Example**:
```javascript
try {
  await trackSalonView(salonId);
  console.log('✅ Tracked view');
} catch (e) {
  console.error('⚠️ Tracking failed:', e);
  // User experience continues normally
}
```

---

## Performance Considerations

1. **Non-Blocking**: All tracking is async and doesn't block UI
2. **Batch Updates**: Counter increments use RPC functions
3. **Indexed Queries**: All analytics queries use indexed columns
4. **Caching**: Frontend caches analytics data (5min TTL)
5. **Pagination**: Reviews and other lists are paginated

---

## Setup Instructions

### 1. Run Database Migration
```bash
psql -h [host] -U [user] -d [database] -f database/migrations/add_tracking_functions.sql
```

### 2. Verify Functions Exist
```sql
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_type='FUNCTION' 
AND routine_name LIKE '%salon%';
```

### 3. Setup Cron Job (Optional)
To update trending scores daily:

```bash
# Add to crontab
0 2 * * * psql -h [host] -U [user] -d [database] -c "SELECT update_all_salons_trending_scores();"
```

---

## Testing

### Test View Tracking
```bash
curl -X POST https://api.salontime.nl/api/salons/{salonId}/track-view \
  -H "x-session-id: test-session-123" \
  -H "x-device-type: iOS 17.1" \
  -H "x-source: app"
```

### Test Favorite Tracking
```bash
curl -X POST https://api.salontime.nl/api/salons/{salonId}/track-favorite \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"action": "add"}'
```

### Verify Analytics
```bash
curl https://api.salontime.nl/api/analytics?salonId={id}&period=30 \
  -H "Authorization: Bearer {token}"
```

---

## Future Enhancements

- [ ] Heatmap of popular booking times
- [ ] Conversion funnel analytics (views → favorites → bookings)
- [ ] Cohort analysis (user retention)
- [ ] Geographic distribution of clients
- [ ] Service popularity tracking
- [ ] Staff performance metrics
- [ ] Competitive benchmarking
- [ ] Predictive analytics (forecast bookings)

---

## Questions?

Contact: tech@salontime.nl
