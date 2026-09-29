function renderLadder(rungs, showLine, task) {
  const section = document.getElementById('ladder');
  section.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Ladder';
  section.append(heading);
  if (showLine && rungs.some(r => r.id === 'G2' && r.state === 'met' && r.evidence?.text)) {
    const line = document.createElement('p');
    line.textContent = "Someone said yes, in writing. That's customer one.";
    section.append(line);
  }
  const list = document.createElement('ol');
  list.className = 'ladder-list';
  for (const rung of rungs) {
    const item = document.createElement('li');
    item.className = 'ladder-rung ' + rung.state;
    if (rung.state === 'met') {
      if (!rung.evidence?.text) continue;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `✓ ${rung.id} ${rung.label}${rung.evidence.date ? ' · ' + rung.evidence.date : ''}`;
      const evidence = document.createElement('p');
      evidence.textContent = rung.evidence.text;
      details.append(summary, evidence);
      item.append(details);
    } else {
      const label = document.createElement('strong');
      label.textContent = `${rung.id} ${rung.label}`;
      item.append(label);
      if (rung.state === 'current') {
        const why = document.createElement('p');
        why.textContent = 'This is the next gate to prove with a buyer.';
        const action = document.createElement('p');
        const next = {
          G0: 'Name a buyer you can reach.',
          G1: 'Ask that buyer what problem they have.',
          G2: 'Ask for a next step in writing.',
          G3: 'Ask whether they accept a price.',
          G4: 'Confirm that payment landed.',
          G5: 'Ask a second buyer for a yes.'
        };
        action.textContent = 'Today: ' + (task || next[rung.id]);
        item.append(why, action);
      }
    }
    list.append(item);
  }
  section.append(list);
}
async function loadLadder(task) {
  const response = await fetch('/api/ladder');
  if (!response.ok) throw new Error('Could not load the ladder.');
  const data = await response.json();
  renderLadder(data.rungs, data.showLine, task);
}
