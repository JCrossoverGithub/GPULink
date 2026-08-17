import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DashboardSnapshot } from './dashboard.models';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly http = inject(HttpClient);

  snapshot(): Observable<DashboardSnapshot> {
    return this.http.get<DashboardSnapshot>('/api/dashboard/snapshot');
  }
}
