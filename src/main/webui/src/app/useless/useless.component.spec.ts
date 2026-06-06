import { ComponentFixture, TestBed } from '@angular/core/testing';

import { UselessComponent } from './useless.component';

describe('UselessComponent', () => {
  let component: UselessComponent;
  let fixture: ComponentFixture<UselessComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UselessComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(UselessComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
