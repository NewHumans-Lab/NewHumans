-- WAKE schedules are executed atomically by the dedicated scheduler path.
-- They are never put into CLAIMED state because dormant subjects must not hold a runtime
-- execution lease merely to become eligible for activity. Autonomous-turn schedules keep
-- the lease-fenced CLAIMED path.
ALTER TABLE runtime.scheduled_actions
  ADD CONSTRAINT scheduled_actions_wake_not_claimed
  CHECK (NOT (action_kind='WAKE' AND status='CLAIMED'));
