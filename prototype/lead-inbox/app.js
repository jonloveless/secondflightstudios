(() => {
  const seed = window.SFS_MOCK_LEADS ?? [];
  let leads = structuredClone(seed);
  let currentLeadId = null;
  let currentFilter = 'active';
  let editing = false;
  let toastTimer = null;

  const inboxScreen = document.querySelector('#inbox-screen');
  const detailScreen = document.querySelector('#detail-screen');
  const leadList = document.querySelector('#lead-list');
  const leadDetail = document.querySelector('#lead-detail');
  const toast = document.querySelector('#toast');
  const sheet = document.querySelector('#assign-sheet');
  const backdrop = document.querySelector('#sheet-backdrop');

  const icons = {
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>',
    call: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92Z"/></svg>',
    assign: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6m3-3h-6"/></svg>',
    snooze: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M5 3 2 6m17-3 3 3"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>'
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);

  function relativeAge(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    if (seconds < 60) return `${seconds} sec ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function responseTime(lead) {
    if (!lead.firstResponseTimestamp) return null;
    const seconds = Math.max(0, Math.round((new Date(lead.firstResponseTimestamp) - new Date(lead.createdTimestamp)) / 1000));
    if (seconds < 60) return `${seconds} sec`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  function isWaitingOnUs(lead) {
    return lead.status === 'New' || lead.status === 'Needs response';
  }

  function getCurrentLead() {
    return leads.find(lead => lead.leadId === currentLeadId);
  }

  function filteredLeads() {
    if (currentFilter === 'closed') return leads.filter(lead => lead.status === 'Closed');
    if (currentFilter === 'needs-response') return leads.filter(isWaitingOnUs);
    return leads.filter(lead => lead.status !== 'Closed');
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => { toast.hidden = true; }, 220);
    }, 2600);
  }

  function urgencyClass(urgency) {
    return `urgency-${urgency.toLowerCase()}`;
  }

  function renderCounts() {
    const active = leads.filter(lead => lead.status !== 'Closed').length;
    const needs = leads.filter(isWaitingOnUs).length;
    const closed = leads.filter(lead => lead.status === 'Closed').length;
    document.querySelector('#active-count').textContent = active;
    document.querySelector('#needs-response-count').textContent = needs;
    document.querySelector('#closed-count').textContent = closed;
    document.querySelector('#needs-you-count').textContent = needs;
  }

  function renderInbox() {
    renderCounts();
    const visibleLeads = filteredLeads();
    document.querySelector('#empty-state').hidden = visibleLeads.length !== 0;
    leadList.innerHTML = visibleLeads.map(lead => {
      const waiting = isWaitingOnUs(lead);
      const owner = lead.assignedPerson || 'Unassigned';
      const responseReady = lead.preparedResponse && waiting;
      return `
        <article class="lead-card ${waiting ? 'is-waiting' : ''}" data-lead-id="${escapeHtml(lead.leadId)}">
          <button class="lead-card-button" type="button" aria-label="Open ${escapeHtml(lead.company || lead.customerName)} lead">
            <div class="lead-meta-row">
              <span class="lead-age ${lead.urgency === 'Urgent' ? 'is-urgent' : ''}">
                <span class="age-dot" aria-hidden="true"></span>${relativeAge(lead.createdTimestamp)}
              </span>
              <span class="lead-source">${escapeHtml(lead.source)}</span>
            </div>
            <div class="lead-title-row">
              <div>
                <h2>${escapeHtml(lead.company || lead.customerName)}</h2>
                ${lead.company ? `<p>${escapeHtml(lead.customerName)}</p>` : ''}
              </div>
              <span class="card-arrow">${icons.arrow}</span>
            </div>
            <p class="lead-summary">${escapeHtml(lead.aiSummary)}</p>
            <div class="signal-row">
              <span class="urgency-pill ${urgencyClass(lead.urgency)}">${escapeHtml(lead.urgency)}</span>
              ${responseReady ? '<span class="ready-pill"><span aria-hidden="true">✦</span> Response ready</span>' : ''}
              ${lead.missingInformation.length ? `<span class="missing-pill">${lead.missingInformation.length} missing</span>` : ''}
            </div>
            <div class="lead-state-row">
              <span class="state-label ${waiting ? 'waiting-us' : 'waiting-them'}">
                <span aria-hidden="true">${waiting ? '←' : '→'}</span>
                ${waiting ? 'Waiting on us' : lead.status === 'Waiting on customer' ? 'Waiting on customer' : escapeHtml(lead.status)}
              </span>
              <span class="card-owner"><span>${owner === 'Unassigned' ? '?' : owner.split(' ').map(part => part[0]).join('').slice(0, 2)}</span>${escapeHtml(owner)}</span>
            </div>
          </button>
        </article>`;
    }).join('');
  }

  function renderDetail() {
    const lead = getCurrentLead();
    if (!lead) return;
    const waiting = isWaitingOnUs(lead);
    const repliedIn = responseTime(lead);
    const phone = lead.phone ? escapeHtml(lead.phone) : 'No phone provided';
    document.querySelector('#detail-id').textContent = lead.leadId;
    leadDetail.innerHTML = `
      <section class="response-clock ${waiting ? 'clock-waiting' : 'clock-done'}">
        <div>
          <span class="clock-kicker">${waiting ? 'CUSTOMER WAITING' : lead.status === 'Waiting on customer' ? 'RESPONSE SENT' : escapeHtml(lead.status).toUpperCase()}</span>
          <strong>${waiting ? relativeAge(lead.createdTimestamp).replace(' ago', '') : repliedIn ? `Replied in ${repliedIn}` : escapeHtml(lead.status)}</strong>
        </div>
        <span class="clock-ready">${waiting ? '<span aria-hidden="true">✦</span> Draft ready' : '✓ Updated'}</span>
      </section>

      <div class="detail-body">
        <div class="detail-identity">
          <div>
            <p class="eyebrow">${escapeHtml(lead.source)} · ${relativeAge(lead.createdTimestamp)}</p>
            <h1 id="detail-title">${escapeHtml(lead.company || lead.customerName)}</h1>
            ${lead.company ? `<p class="contact-name">${escapeHtml(lead.customerName)}</p>` : ''}
          </div>
          <span class="urgency-pill ${urgencyClass(lead.urgency)}">${escapeHtml(lead.urgency)}</span>
        </div>

        <div class="ownership-strip">
          <span class="status-badge">${escapeHtml(lead.status)}</span>
          <span class="ownership-divider" aria-hidden="true"></span>
          <button type="button" data-action="assign"><span class="mini-avatar">${lead.assignedPerson ? lead.assignedPerson.slice(0, 1) : '?'}</span>${escapeHtml(lead.assignedPerson || 'Assign owner')}</button>
        </div>

        <section class="detail-section ai-brief">
          <div class="section-title-row">
            <h2><span aria-hidden="true">✦</span> AI brief</h2>
            <span>READY TO REVIEW</span>
          </div>
          <p class="brief-copy">${escapeHtml(lead.aiSummary)}</p>
          ${lead.missingInformation.length ? `
            <div class="missing-callout">
              <strong>Missing information</strong>
              <ul>${lead.missingInformation.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
            </div>` : '<div class="complete-callout">✓ No critical information missing</div>'}
          <div class="next-action">
            <span>RECOMMENDED NEXT ACTION</span>
            <p>${escapeHtml(lead.recommendedNextAction)}</p>
          </div>
        </section>

        <section class="detail-section prepared-response">
          <div class="section-title-row">
            <h2>Prepared response</h2>
            <span class="draft-badge">DRAFT</span>
          </div>
          ${editing
            ? `<textarea id="response-editor" aria-label="Edit prepared response">${escapeHtml(lead.preparedResponse)}</textarea>`
            : `<p class="response-copy">${escapeHtml(lead.preparedResponse)}</p>`}
          <div class="response-actions">
            <button type="button" class="secondary-action" data-action="edit">${icons.edit}${editing ? 'Save edit' : 'Edit response'}</button>
            <button type="button" class="secondary-action" data-action="copy">${icons.copy}Copy</button>
          </div>
          <button type="button" class="approve-action" data-action="approve" ${lead.status === 'Closed' ? 'disabled' : ''}>
            <span>${lead.firstResponseTimestamp ? 'Approve follow-up' : 'Approve & send response'}</span>
            ${icons.arrow}
          </button>
          <p class="prototype-note">Prototype only — approval changes local screen state and sends nothing.</p>
        </section>

        <details class="original-inquiry">
          <summary><span>Original inquiry</span><small>${escapeHtml(lead.originalInquiry.slice(0, 66))}${lead.originalInquiry.length > 66 ? '…' : ''}</small></summary>
          <p>${escapeHtml(lead.originalInquiry)}</p>
        </details>

        <section class="contact-details">
          <h2>Contact</h2>
          <dl>
            <div><dt>Email</dt><dd>${escapeHtml(lead.email)}</dd></div>
            <div><dt>Phone</dt><dd>${phone}</dd></div>
            <div><dt>Source</dt><dd>${escapeHtml(lead.source)}</dd></div>
          </dl>
        </section>
      </div>

      <nav class="action-dock" aria-label="Lead actions">
        <button type="button" data-action="call" ${lead.phone ? '' : 'disabled'}>${icons.call}<span>Call</span></button>
        <button type="button" data-action="assign">${icons.assign}<span>Assign</span></button>
        <button type="button" data-action="snooze">${icons.snooze}<span>Snooze</span></button>
        <button type="button" data-action="close">${icons.close}<span>${lead.status === 'Closed' ? 'Reopen' : 'Close'}</span></button>
      </nav>`;
  }

  function openLead(leadId) {
    currentLeadId = leadId;
    editing = false;
    renderDetail();
    inboxScreen.hidden = true;
    detailScreen.hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function closeDetail() {
    detailScreen.hidden = true;
    inboxScreen.hidden = false;
    currentLeadId = null;
    renderInbox();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function updateLead(changes) {
    leads = leads.map(lead => lead.leadId === currentLeadId
      ? { ...lead, ...changes, updatedTimestamp: new Date().toISOString() }
      : lead);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Response copied to clipboard');
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast('Response copied to clipboard');
    }
  }

  function openAssignSheet() {
    const lead = getCurrentLead();
    sheet.querySelectorAll('[data-assignee]').forEach(button => {
      button.classList.toggle('is-selected', button.dataset.assignee === lead.assignedPerson);
    });
    backdrop.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(() => {
      backdrop.classList.add('is-open');
      sheet.classList.add('is-open');
      sheet.querySelector('[data-assignee]')?.focus();
    });
  }

  function closeAssignSheet() {
    backdrop.classList.remove('is-open');
    sheet.classList.remove('is-open');
    setTimeout(() => {
      backdrop.hidden = true;
      sheet.hidden = true;
    }, 220);
  }

  function handleAction(action) {
    const lead = getCurrentLead();
    if (!lead) return;
    if (action === 'edit') {
      if (editing) {
        const response = document.querySelector('#response-editor')?.value.trim();
        if (response) updateLead({ preparedResponse: response });
        editing = false;
        renderDetail();
        showToast('Draft updated locally');
      } else {
        editing = true;
        renderDetail();
        document.querySelector('#response-editor')?.focus();
      }
    }
    if (action === 'copy') copyText(lead.preparedResponse);
    if (action === 'approve') {
      if (editing) {
        const response = document.querySelector('#response-editor')?.value.trim();
        if (response) updateLead({ preparedResponse: response });
        editing = false;
      }
      updateLead({
        status: 'Waiting on customer',
        firstResponseTimestamp: lead.firstResponseTimestamp || new Date().toISOString()
      });
      renderDetail();
      showToast('Approved locally · no message sent');
    }
    if (action === 'call') showToast(`Call preview · ${lead.phone || 'no number available'}`);
    if (action === 'assign') openAssignSheet();
    if (action === 'snooze') {
      const until = new Date(Date.now() + 60 * 60 * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      showToast(`Snoozed locally until ${until}`);
    }
    if (action === 'close') {
      updateLead({ status: lead.status === 'Closed' ? 'Needs response' : 'Closed' });
      renderDetail();
      showToast(lead.status === 'Closed' ? 'Lead reopened locally' : 'Lead closed locally');
    }
  }

  leadList.addEventListener('click', event => {
    const card = event.target.closest('[data-lead-id]');
    if (card) openLead(card.dataset.leadId);
  });

  leadDetail.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (target && !target.disabled) handleAction(target.dataset.action);
  });

  document.querySelector('#back-button').addEventListener('click', closeDetail);
  document.querySelector('#more-button').addEventListener('click', () => showToast('Static prototype · mock data only'));
  document.querySelector('#reset-demo').addEventListener('click', () => {
    leads = structuredClone(seed);
    currentFilter = 'active';
    document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.filter === 'active'));
    renderInbox();
    showToast('Prototype data reset');
  });

  document.querySelector('.filter-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    currentFilter = button.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('is-active', tab === button));
    renderInbox();
  });

  sheet.addEventListener('click', event => {
    if (event.target.closest('.sheet-close')) return closeAssignSheet();
    const option = event.target.closest('[data-assignee]');
    if (!option) return;
    updateLead({ assignedPerson: option.dataset.assignee });
    renderDetail();
    closeAssignSheet();
    showToast(option.dataset.assignee ? `Assigned to ${option.dataset.assignee}` : 'Returned to shared queue');
  });
  backdrop.addEventListener('click', closeAssignSheet);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!sheet.hidden) closeAssignSheet();
    else if (!detailScreen.hidden) closeDetail();
  });

  renderInbox();
  setInterval(() => {
    if (detailScreen.hidden) renderInbox();
    else renderDetail();
  }, 15000);
})();
