// ============================================================
// CONFIGURATION
// ============================================================

export const BASES = {
  invitations: 'appgvcig9jwAhim6W',
  tickets: 'appgvcig9jwAhim6W',
  syncState: 'appgvcig9jwAhim6W',
};

export const TABLES = {
  invitations: 'Current Invite List',
  // Currently pointing at {{API TEST}} — swap to 'BSS\'26' (tblVGGdO9QrRYi50x) when ready for prod
  tickets: '{{API TEST}}',
  syncState: '{{Sync State}}',
};

// The Airtable field used to uniquely identify each SP record (upsert merge key)
export const MERGE_FIELDS = {
  invitations: 'SP ID',
  tickets: 'SP ID',
};

// Field mapping: Secret Party API field → Airtable field name
// Nested fields use dot notation: 'product.name' → top-level product name string
export const FIELD_MAP = {
  invitations: {
    id: 'SP ID',
    code: 'Invite Code',
    first_name: 'First Name',
    last_name: 'Last Name',
    email: 'Email',
    phone: 'Phone',
    stage: 'SP Stage',
    status: 'SP Status',
    level: 'SP Level',
    invites_per: 'SP Invites Per',
    view_count: 'SP View Count',
    created_invitation_count: 'SP Created Invitation Count',
    claimed_ticket_count: 'SP Claimed Ticket Count',
    last_viewed_at: 'SP Last Viewed At',
    created_at: 'SP Created At',
    updated_at: 'SP Updated At',
    // Nested fields
    'inviter.name': 'SP Inviter Name',
    'parent_invitation.id': 'SP Parent Invitation ID',
    'parent_invitation.code': 'SP Parent Invitation Code',
  },
  tickets: {
    id: 'SP ID',
    code: 'Ticket Code',
    invitation_code: 'Invitation Code',
    invitation_id: 'SP Invitation ID',
    first_name: 'First Name',
    last_name: 'Last Name',
    email: 'Email from SP',
    phone: 'Phone',
    stage: 'SP Stage',
    status: 'SP Status',
    invites_per: 'SP Invites Per',
    purchase_price: 'SP Purchase Price',
    total: 'SP Total',
    is_checked_in: 'SP Is Checked In',
    checkin_updated_at: 'SP Checkin At',
    transfer_status: 'SP Transfer Status',
    transferee_first_name: 'SP Transferee First Name',
    transferee_last_name: 'SP Transferee Last Name',
    transferee_email: 'SP Transferee Email',
    transferer_first_name: 'SP Transferer First Name',
    transferer_last_name: 'SP Transferer Last Name',
    transferer_email: 'SP Transferer Email',
    surcharge_fee: 'SP Surcharge Fee',
    service_fee: 'SP Service Fee',
    processing_fee: 'SP Processing Fee',
    transfer_fee: 'SP Transfer Fee',
    transfer_requires_payment: 'SP Transfer Requires Payment',
    sales_organizer_revenue_amount: 'SP Sales Organizer Revenue',
    total_unlocked_by_count: 'SP Total Unlocked By Count',
    created_at: 'SP Created At',
    updated_at: 'SP Updated At',
    // Nested fields
    'product.name': 'SP Product Name',
    'product.type': 'SP Product Type',
    'product.is_transfer_allowed': 'SP Product Transfer Allowed',
  },
};

export const SP_BASE_URL = 'https://api.secretparty.io/secret';
