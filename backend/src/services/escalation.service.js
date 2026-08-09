const { pool } = require('../db');

/**
 * Creates an escalation flag and routes to the assigned doctor or coordinator
 */
async function createEscalationFlag({ patientId, conversationId, flagType, priority, assignedDoctorId, reason }) {
  // Route to the staff login linked to the patient's assigned doctor, if any.
  let assignedStaffId = null;

  if (assignedDoctorId) {
    const docStaff = await pool.query(
      'SELECT staff_user_id FROM doctors WHERE id = $1',
      [assignedDoctorId]
    );
    assignedStaffId = docStaff.rows[0]?.staff_user_id || null;
  }

  const query = `
    INSERT INTO flags (patient_id, conversation_id, flag_type, priority, status, assigned_to)
    VALUES ($1, $2, $3, $4, 'open', $5)
    RETURNING id;
  `;
  const values = [patientId, conversationId || null, flagType, priority, assignedStaffId];
  const { rows } = await pool.query(query, values);

  return rows[0].id;
}

/**
 * Auto-fallback worker: Escalates unresolved flags to central coordinator queue after timeout
 */
async function reassignStaleFlags() {
  // 2 hours for urgent flags, 24 hours for normal flags
  const updateQuery = `
    UPDATE flags
    SET assigned_to = NULL
    WHERE status = 'open'
      AND (
        (priority = 'urgent' AND created_at <= NOW() - INTERVAL '2 hours') OR
        (priority = 'normal' AND created_at <= NOW() - INTERVAL '24 hours')
      );
  `;
  await pool.query(updateQuery);
}

module.exports = { createEscalationFlag, reassignStaleFlags };
