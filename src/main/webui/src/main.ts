import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// if((window as any).__coverage__) {
//   document.addEventListener('keydown', (e) => {
//     if (e.ctrlKey && e.shiftKey && e.key === 'F12') {
//       const coverage = (window as any).__coverage__;
//       if (!coverage) return;

//       const blob = new Blob(
//         [JSON.stringify(coverage)],
//         { type: 'application/json' }
//       );
//       const a = document.createElement('a');
//       a.href = URL.createObjectURL(blob);
//       a.download = `coverage-${new Date().toISOString()}.json`;
//       a.click();
//       URL.revokeObjectURL(a.href);
//       console.info('📊 Coverage exporté');
//     }
//   });
// }

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
