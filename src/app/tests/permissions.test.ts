import {
  createMockUser,
  createMockUserWithRole,
  createMockUserWithPlan,
  createMockUserWithPermissions,
  assertHasPermission,
  assertLacksPermission,
  assertHasAllPermissions,
  TestScenarios,
  PermissionMatrix,
  validatePermissionMatrix,
  simulatePermissionCheck,
} from '../utils/permission-test.utils';
import { Permission } from '../types/permissions.types';
import { UserRole } from '../models/user.model';
import { PlanSlug } from '../types/plan.types';

describe('Permission System Tests', () => {
  describe('Mock User Creation', () => {
    it('should create a basic mock user', () => {
      const user = createMockUser();
      expect(user._id).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.role).toBe(UserRole.User);
      expect(user.plan).toBe(PlanSlug.Free);
    });

    it('should create a mock user with overrides', () => {
      const user = createMockUser({
        email: 'admin@example.com',
        role: UserRole.Admin,
      });
      expect(user.email).toBe('admin@example.com');
      expect(user.role).toBe(UserRole.Admin);
    });

    it('should create a mock user with specific role', () => {
      const adminUser = createMockUserWithRole(UserRole.Admin);
      expect(adminUser.role).toBe(UserRole.Admin);
      expect(adminUser.permissions.length).toBeGreaterThan(0);
    });

    it('should create a mock user with specific plan', () => {
      const proUser = createMockUserWithPlan(PlanSlug.Pro);
      expect(proUser.plan).toBe(PlanSlug.Pro);
      expect(proUser.permissions).toContain(Permission.EXPENSE_EXPORT);
    });
  });

  describe('Permission Assertions', () => {
    it('should assert user has permission', () => {
      const user = createMockUserWithPermissions([Permission.EXPENSE_CREATE]);
      expect(() => {
        assertHasPermission(user, Permission.EXPENSE_CREATE);
      }).not.toThrow();
    });

    it('should throw when user lacks permission', () => {
      const user = createMockUserWithPermissions([]);
      expect(() => {
        assertHasPermission(user, Permission.EXPENSE_CREATE);
      }).toThrow();
    });

    it('should assert user lacks permission', () => {
      const user = createMockUserWithPermissions([]);
      expect(() => {
        assertLacksPermission(user, Permission.EXPENSE_CREATE);
      }).not.toThrow();
    });

    it('should assert user has all permissions', () => {
      const user = createMockUserWithPermissions([
        Permission.EXPENSE_CREATE,
        Permission.EXPENSE_READ,
        Permission.EXPENSE_UPDATE,
      ]);
      expect(() => {
        assertHasAllPermissions(user, [
          Permission.EXPENSE_CREATE,
          Permission.EXPENSE_READ,
        ]);
      }).not.toThrow();
    });
  });

  describe('Role-Based Permissions', () => {
    it('should grant basic permissions to regular users', () => {
      const user = createMockUserWithRole(UserRole.User);
      expect(user.permissions).toContain(Permission.EXPENSE_CREATE);
      expect(user.permissions).toContain(Permission.EXPENSE_READ);
      expect(user.permissions).not.toContain(Permission.ADMIN_DASHBOARD);
    });

    it('should grant admin permissions to moderators', () => {
      const moderator = createMockUserWithRole(UserRole.Moderator);
      expect(moderator.permissions).toContain(Permission.ADMIN_DASHBOARD);
      expect(moderator.permissions).not.toContain(Permission.ADMIN_USERS);
    });

    it('should grant user management to admins', () => {
      const admin = createMockUserWithRole(UserRole.Admin);
      expect(admin.permissions).toContain(Permission.ADMIN_DASHBOARD);
      expect(admin.permissions).toContain(Permission.ADMIN_USERS);
      expect(admin.permissions).not.toContain(Permission.ADMIN_PLANS);
    });

    it('should grant all permissions to superadmins', () => {
      const superAdmin = createMockUserWithRole(UserRole.SuperAdmin);
      expect(superAdmin.permissions).toContain(Permission.ADMIN_DASHBOARD);
      expect(superAdmin.permissions).toContain(Permission.ADMIN_USERS);
      expect(superAdmin.permissions).toContain(Permission.ADMIN_PLANS);
    });
  });

  describe('Plan-Based Permissions', () => {
    it('should grant basic permissions to free users', () => {
      const freeUser = createMockUserWithPlan(PlanSlug.Free);
      expect(freeUser.permissions).toContain(Permission.EXPENSE_CREATE);
      expect(freeUser.permissions).toContain(Permission.REPORT_VIEW);
      expect(freeUser.permissions).not.toContain(Permission.EXPENSE_EXPORT);
    });

    it('should grant advanced features to pro users', () => {
      const proUser = createMockUserWithPlan(PlanSlug.Pro);
      expect(proUser.permissions).toContain(Permission.EXPENSE_EXPORT);
      expect(proUser.permissions).toContain(Permission.REPORT_ADVANCED);
      expect(proUser.permissions).toContain(Permission.BACKUP_GDRIVE);
    });

    it('should grant all features to premium users', () => {
      const premiumUser = createMockUserWithPlan(PlanSlug.Premium);
      expect(premiumUser.permissions).toContain(Permission.EXPENSE_EXPORT);
      expect(premiumUser.permissions).toContain(
        Permission.SECURITY_ADVANCED_ENCRYPTION
      );
      expect(premiumUser.permissions).toContain(Permission.SYNC_MULTI_DEVICE);
    });
  });

  describe('Test Scenarios', () => {
    it('should deny export for free users', () => {
      const scenario = TestScenarios.freeUserExport;
      const result = simulatePermissionCheck(
        scenario.user,
        scenario.permission
      );
      expect(result.granted).toBe(scenario.shouldPass);
    });

    it('should allow export for pro users', () => {
      const scenario = TestScenarios.proUserExport;
      const result = simulatePermissionCheck(
        scenario.user,
        scenario.permission
      );
      expect(result.granted).toBe(scenario.shouldPass);
    });

    it('should deny admin access for regular users', () => {
      const scenario = TestScenarios.userAccessAdmin;
      const result = simulatePermissionCheck(
        scenario.user,
        scenario.permission
      );
      expect(result.granted).toBe(scenario.shouldPass);
    });

    it('should deny plan management for admins', () => {
      const scenario = TestScenarios.adminManagePlans;
      const result = simulatePermissionCheck(
        scenario.user,
        scenario.permission
      );
      expect(result.granted).toBe(scenario.shouldPass);
    });

    it('should allow plan management for superadmins', () => {
      const scenario = TestScenarios.superAdminManagePlans;
      const result = simulatePermissionCheck(
        scenario.user,
        scenario.permission
      );
      expect(result.granted).toBe(scenario.shouldPass);
    });
  });

  describe('Permission Matrix Validation', () => {
    it('should have a valid permission matrix', () => {
      const validation = validatePermissionMatrix();
      if (!validation.valid) {
        console.error('Permission Matrix Errors:', validation.errors);
      }
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should have permissions defined for all roles', () => {
      Object.values(UserRole).forEach((role) => {
        expect(PermissionMatrix.roles[role]).toBeDefined();
        expect(PermissionMatrix.roles[role].length).toBeGreaterThan(0);
      });
    });

    it('should have permissions defined for all plans', () => {
      Object.values(PlanSlug).forEach((plan) => {
        expect(PermissionMatrix.plans[plan]).toBeDefined();
        expect(PermissionMatrix.plans[plan].length).toBeGreaterThan(0);
      });
    });
  });

  describe('Permission Hierarchy', () => {
    it('should ensure moderators have all user permissions', () => {
      const userPerms = PermissionMatrix.roles[UserRole.User];
      const modPerms = PermissionMatrix.roles[UserRole.Moderator];

      userPerms.forEach((perm) => {
        expect(modPerms).toContain(perm);
      });
    });

    it('should ensure admins have all moderator permissions', () => {
      const modPerms = PermissionMatrix.roles[UserRole.Moderator];
      const adminPerms = PermissionMatrix.roles[UserRole.Admin];

      modPerms.forEach((perm) => {
        expect(adminPerms).toContain(perm);
      });
    });

    it('should ensure superadmins have all admin permissions', () => {
      const adminPerms = PermissionMatrix.roles[UserRole.Admin];
      const superAdminPerms = PermissionMatrix.roles[UserRole.SuperAdmin];

      adminPerms.forEach((perm) => {
        expect(superAdminPerms).toContain(perm);
      });
    });

    it('should ensure pro plan has all free plan permissions', () => {
      const freePerms = PermissionMatrix.plans[PlanSlug.Free];
      const proPerms = PermissionMatrix.plans[PlanSlug.Pro];

      freePerms.forEach((perm) => {
        expect(proPerms).toContain(perm);
      });
    });

    it('should ensure premium plan has all pro plan permissions', () => {
      const proPerms = PermissionMatrix.plans[PlanSlug.Pro];
      const premiumPerms = PermissionMatrix.plans[PlanSlug.Premium];

      proPerms.forEach((perm) => {
        expect(premiumPerms).toContain(perm);
      });
    });
  });
});
