// Boîtes de dialogue modales (élément <dialog> natif).
import { h } from './dom.ts';

export interface ConfirmOptions {
  title: string;
  body?: (Node | string | null | false | undefined)[];
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const okBtn = h('button', { class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', 'data-testid': 'dialog-ok' }, opts.ok ?? 'Confirmer');
    const cancelBtn = h('button', { class: 'btn', type: 'button', 'data-testid': 'dialog-cancel' }, opts.cancel ?? 'Annuler');
    const dlg = h(
      'dialog',
      { class: 'dialog' },
      h('h2', null, opts.title),
      h('div', { class: 'dialog-body' }, ...(opts.body ?? []).filter((x): x is Node | string => !!x)),
      h('div', { class: 'dialog-actions' }, cancelBtn, okBtn),
    );
    const done = (v: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    okBtn.addEventListener('click', () => done(true));
    cancelBtn.addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (opts.danger ? cancelBtn : okBtn).focus();
  });
}
