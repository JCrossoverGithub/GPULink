import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { catchError, map, merge, of, Subject, switchMap, timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DashboardSnapshot, Gpu, Job, Worker } from './dashboard.models';
import { DashboardService } from './dashboard.service';

interface SnapshotResult {
  snapshot: DashboardSnapshot | null;
  error: string | null;
}

@Component({
  selector: 'gl-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly dashboard = inject(DashboardService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly manualRefresh = new Subject<void>();

  readonly snapshot = signal<DashboardSnapshot | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    merge(timer(0, 5_000), this.manualRefresh)
      .pipe(
        switchMap(() => {
          this.loading.set(this.snapshot() === null);
          return this.dashboard.snapshot().pipe(
            map((snapshot): SnapshotResult => ({ snapshot, error: null })),
            catchError(() => of<SnapshotResult>({
              snapshot: null,
              error: 'The operations gateway did not return a snapshot.',
            })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        if (result.snapshot !== null) {
          this.snapshot.set(result.snapshot);
        }
        this.error.set(result.error);
        this.loading.set(false);
      });
  }

  refresh(): void {
    this.manualRefresh.next();
  }

  memoryPercent(gpu: Gpu): number {
    if (gpu.memoryTotalMiB <= 0) return 0;
    return this.clamp((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100);
  }

  memoryFreeMiB(gpu: Gpu): string {
    return Math.max(gpu.memoryTotalMiB - gpu.memoryUsedMiB, 0).toLocaleString(
      undefined,
      { maximumFractionDigits: 0 },
    );
  }

  powerLabel(gpu: Gpu): string {
    return gpu.powerDrawWatts === null ? 'N/A' : `${gpu.powerDrawWatts.toFixed(1)} W`;
  }

  utilizationPercent(gpu: Gpu): number {
    return this.clamp(gpu.utilizationPercent);
  }

  temperaturePercent(gpu: Gpu): number {
    return this.clamp((gpu.temperatureC / 90) * 100);
  }

  powerPercent(gpu: Gpu): number {
    return this.clamp(((gpu.powerDrawWatts ?? 0) / 320) * 100);
  }

  workerState(worker: Worker): string {
    if (worker.drainMode) return 'drained';
    return worker.status;
  }

  shortId(id: string | null, prefixLength = 11): string {
    if (!id) return 'unassigned';
    return id.length > prefixLength ? `${id.slice(0, prefixLength)}…` : id;
  }

  jobAge(job: Job): string {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - job.createdAt) / 1_000));
    if (ageSeconds < 60) return `${ageSeconds}s`;
    if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)}m`;
    if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3_600)}h`;
    return `${Math.floor(ageSeconds / 86_400)}d`;
  }

  statusCount(snapshot: DashboardSnapshot, status: string): number {
    return snapshot.jobsByStatus[status] ?? 0;
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 100);
  }
}
