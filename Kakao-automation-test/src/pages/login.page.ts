import { Page } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  private readonly emailInput = this.page.locator('input[name="email"]');
  private readonly passwordInput = this.page.locator('input[name="password"]');
  private readonly loginButton = this.page.getByRole('button', { name: 'Đăng nhập' });
  private readonly heading = this.page.getByRole('heading', { name: 'Đăng nhập tài khoản' });

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.goto('/login');
  }

  async isLoginFormDisplayed(): Promise<boolean> {
    return this.isVisible(this.heading);
  }

  async fillEmail(email: string): Promise<void> {
    await this.type(this.emailInput, email, 'Email field');
  }

  async fillPassword(password: string): Promise<void> {
    await this.type(this.passwordInput, password, 'Password field');
  }

  async submit(): Promise<void> {
    await this.click(this.loginButton, 'Đăng nhập (Log in) button');
  }

  async login(email: string, password: string): Promise<void> {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.submit();
  }
}
