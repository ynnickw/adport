export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          key_prefix: string
          last_used_at: string | null
          name: string
          organization_id: string
          revoked_at: string | null
          scopes: string[]
          secret_hash: string
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          organization_id: string
          revoked_at?: string | null
          scopes?: string[]
          secret_hash: string
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          organization_id?: string
          revoked_at?: string | null
          scopes?: string[]
          secret_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          account_id: string
          actor_user_id: string | null
          api_key_id: string | null
          created_at: string
          details: Json | null
          event: string
          id: number
          organization_id: string
          pending_id: string | null
          provider: string
          summary: string
          tool: string
        }
        Insert: {
          account_id: string
          actor_user_id?: string | null
          api_key_id?: string | null
          created_at?: string
          details?: Json | null
          event: string
          id?: never
          organization_id: string
          pending_id?: string | null
          provider: string
          summary: string
          tool: string
        }
        Update: {
          account_id?: string
          actor_user_id?: string | null
          api_key_id?: string | null
          created_at?: string
          details?: Json | null
          event?: string
          id?: never
          organization_id?: string
          pending_id?: string | null
          provider?: string
          summary?: string
          tool?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          connected_at: string
          connected_by: string
          external_label: string | null
          external_subject: string | null
          id: string
          last_error: string | null
          last_verified_at: string | null
          organization_id: string
          provider: string
          revoked_at: string | null
          scopes: string[]
          status: Database["public"]["Enums"]["connection_status"]
        }
        Insert: {
          connected_at?: string
          connected_by: string
          external_label?: string | null
          external_subject?: string | null
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          organization_id: string
          provider: string
          revoked_at?: string | null
          scopes?: string[]
          status?: Database["public"]["Enums"]["connection_status"]
        }
        Update: {
          connected_at?: string
          connected_by?: string
          external_label?: string | null
          external_subject?: string | null
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          organization_id?: string
          provider?: string
          revoked_at?: string | null
          scopes?: string[]
          status?: Database["public"]["Enums"]["connection_status"]
        }
        Relationships: [
          {
            foreignKeyName: "connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      deletion_requests: {
        Row: {
          completed_at: string | null
          error: string | null
          id: string
          organization_id: string
          requested_at: string
          requested_by: string | null
          status: Database["public"]["Enums"]["deletion_status"]
        }
        Insert: {
          completed_at?: string | null
          error?: string | null
          id?: string
          organization_id: string
          requested_at?: string
          requested_by?: string | null
          status?: Database["public"]["Enums"]["deletion_status"]
        }
        Update: {
          completed_at?: string | null
          error?: string | null
          id?: string
          organization_id?: string
          requested_at?: string
          requested_by?: string | null
          status?: Database["public"]["Enums"]["deletion_status"]
        }
        Relationships: [
          {
            foreignKeyName: "deletion_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          created_at: string
          created_by: string
          id: string
          kind: string
          message: string
          notification_error: string | null
          notification_status: string
          organization_id: string
          page_path: string | null
          resend_email_id: string | null
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          kind?: string
          message: string
          notification_error?: string | null
          notification_status?: string
          organization_id: string
          page_path?: string | null
          resend_email_id?: string | null
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          message?: string
          notification_error?: string | null
          notification_status?: string
          organization_id?: string
          page_path?: string | null
          resend_email_id?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          created_at: string
          finding: Json
          id: string
          organization_id: string
          provider: string
          severity: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          finding: Json
          id: string
          organization_id: string
          provider: string
          severity: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          finding?: Json
          id?: string
          organization_id?: string
          provider?: string
          severity?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "findings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_ad_accounts: {
        Row: {
          account_id: string
          connection_id: string
          currency: string | null
          discovered_at: string
          enabled: boolean
          last_seen_at: string
          name: string
          organization_id: string
          provider: string
          status: string | null
        }
        Insert: {
          account_id: string
          connection_id: string
          currency?: string | null
          discovered_at?: string
          enabled?: boolean
          last_seen_at?: string
          name: string
          organization_id: string
          provider: string
          status?: string | null
        }
        Update: {
          account_id?: string
          connection_id?: string
          currency?: string | null
          discovered_at?: string
          enabled?: boolean
          last_seen_at?: string
          name?: string
          organization_id?: string
          provider?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_ad_accounts_connection_id_organization_id_pro_fkey"
            columns: ["connection_id", "organization_id", "provider"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id", "organization_id", "provider"]
          },
          {
            foreignKeyName: "organization_ad_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          created_at: string
          organization_id: string
          role: Database["public"]["Enums"]["organization_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role?: Database["public"]["Enums"]["organization_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["organization_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_onboarding: {
        Row: {
          completed_at: string | null
          created_at: string
          current_step: string
          organization_id: string
          selected_agent: string | null
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_step?: string
          organization_id: string
          selected_agent?: string | null
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_step?: string
          organization_id?: string
          selected_agent?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_onboarding_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_settings: {
        Row: {
          data_retention_days: number
          organization_id: string
          policy: Json
          updated_at: string
        }
        Insert: {
          data_retention_days?: number
          organization_id: string
          policy?: Json
          updated_at?: string
        }
        Update: {
          data_retention_days?: number
          organization_id?: string
          policy?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_subscriptions: {
        Row: {
          billing_provider: string | null
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          organization_id: string
          plan: Database["public"]["Enums"]["cloud_plan"]
          provider_customer_id: string | null
          provider_subscription_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          billing_provider?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          organization_id: string
          plan?: Database["public"]["Enums"]["cloud_plan"]
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          billing_provider?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          organization_id?: string
          plan?: Database["public"]["Enums"]["cloud_plan"]
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      pending_operations: {
        Row: {
          consumed_at: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          operation: Json
          operation_hash: string
          organization_id: string
          preview: Json
          provider: string
        }
        Insert: {
          consumed_at?: string | null
          created_at: string
          created_by?: string | null
          expires_at: string
          id: string
          operation: Json
          operation_hash: string
          organization_id: string
          preview: Json
          provider: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          operation?: Json
          operation_hash?: string
          organization_id?: string
          preview?: Json
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_operations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      cloud_plan: "reader" | "operator" | "premium" | "agency" | "enterprise"
      connection_status: "connected" | "error" | "revoked"
      deletion_status: "requested" | "processing" | "completed" | "failed"
      organization_role: "owner" | "admin" | "member" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      cloud_plan: ["reader", "operator", "premium", "agency", "enterprise"],
      connection_status: ["connected", "error", "revoked"],
      deletion_status: ["requested", "processing", "completed", "failed"],
      organization_role: ["owner", "admin", "member", "viewer"],
    },
  },
} as const

